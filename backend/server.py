"""
FastAPI + WebSocket bridge for Sightline
Proxies audio/video frames between the PWA and Gemini Live via ADK run_live.

Architecture:
    Browser (PWA) <--WS--> FastAPI (this file) <--WS--> Gemini Live API
                                                    (via ADK LiveRequestQueue)
"""

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import re

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

MAX_CONCURRENT = 5
MAX_PER_IP = 2
SESSION_TIMEOUT = 600  # 10 minutes

_active_connections: int = 0
_connections_by_ip: dict[str, int] = defaultdict(int)
_lock = asyncio.Lock()

BRIEFING_END_RE = re.compile(r"ready(?:\s+when\s+you\s+are|\s+for)?\s+for\s+the\s+visual\s+inspection\.?", re.IGNORECASE)

app = FastAPI(title="Sightline API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.get("/health")
async def health():
    return {"status": "ok", "service": "sightline"}


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


def _get_client_ip(websocket: WebSocket) -> str:
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return websocket.client.host if websocket.client else "unknown"


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global _active_connections
    client_ip = _get_client_ip(websocket)

    async with _lock:
        if _active_connections >= MAX_CONCURRENT:
            await websocket.close(code=1013, reason="Server at capacity")
            logger.warning(f"Rejected {client_ip}: global limit ({_active_connections}/{MAX_CONCURRENT})")
            return
        if _connections_by_ip[client_ip] >= MAX_PER_IP:
            await websocket.close(code=1013, reason="Too many connections from this IP")
            logger.warning(f"Rejected {client_ip}: per-IP limit ({_connections_by_ip[client_ip]}/{MAX_PER_IP})")
            return
        _active_connections += 1
        _connections_by_ip[client_ip] += 1

    await websocket.accept()
    session_start = time.monotonic()
    logger.info(f"Connection from {client_ip} ({_active_connections} active, {_connections_by_ip[client_ip]} from this IP)")

    try:
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.live_request_queue import LiveRequestQueue
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from google.genai import types
        from backend.agent import root_agent

        session_service = InMemorySessionService()
        runner = Runner(
            agent=root_agent,
            app_name="sightline",
            session_service=session_service,
        )

        session_id = f"field-{uuid.uuid4().hex[:8]}"
        await session_service.create_session(
            app_name="sightline",
            user_id="inspector",
            session_id=session_id,
        )

        live_request_queue = LiveRequestQueue()

        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
                )
            ),
            response_modalities=["AUDIO"],
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
        )

        agent_speaking = False
        cooldown_until = 0.0
        briefing_delivered = False
        last_output_transcript = ""
        turn_mode = "briefing"
        completed_model_turns = 0
        model_output_seen_in_turn = False
        await websocket.send_json({"type": "ready"})
        logger.info(f"Session {session_id} started")

        async def receive_from_browser():
            nonlocal agent_speaking, cooldown_until, briefing_delivered, last_output_transcript, turn_mode, completed_model_turns, model_output_seen_in_turn
            try:
                while True:
                    try:
                        data = await asyncio.wait_for(websocket.receive(), timeout=30.0)
                    except asyncio.TimeoutError:
                        await websocket.send_json({"type": "ping"})
                        continue

                    if "bytes" in data and data["bytes"]:
                        raw = data["bytes"]
                        if len(raw) > 1:
                            msg_type = raw[0]
                            payload = raw[1:]
                            if msg_type == 0x01:
                                import time
                                # In briefing mode, allow only one completed model response per explicit start_turn.
                                if turn_mode == "briefing" and briefing_delivered:
                                    continue
                                if agent_speaking or time.time() < cooldown_until:
                                    continue
                                live_request_queue.send_realtime(
                                    types.Blob(data=payload, mime_type="audio/pcm;rate=16000")
                                )
                            elif msg_type == 0x02:
                                live_request_queue.send_realtime(
                                    types.Blob(data=payload, mime_type="image/jpeg")
                                )

                    elif "text" in data and data["text"]:
                        try:
                            msg = json.loads(data["text"])
                            if msg.get("type") == "pong":
                                pass
                            elif msg.get("type") == "start_turn":
                                briefing_delivered = False
                                last_output_transcript = ""
                                turn_mode = msg.get("mode", "briefing")
                                completed_model_turns = 0
                                model_output_seen_in_turn = False
                        except json.JSONDecodeError:
                            pass

            except WebSocketDisconnect:
                logger.info("Browser disconnected")
            finally:
                live_request_queue.close()

        async def send_to_browser():
            nonlocal agent_speaking, cooldown_until, briefing_delivered, last_output_transcript, completed_model_turns, model_output_seen_in_turn
            try:
                async for event in runner.run_live(
                    user_id="inspector",
                    session_id=session_id,
                    live_request_queue=live_request_queue,
                    run_config=run_config,
                ):
                    if event.content and event.content.parts:
                        for part in event.content.parts:
                            if part.inline_data and "audio" in (part.inline_data.mime_type or ""):
                                if turn_mode == "briefing" and completed_model_turns >= 1:
                                    continue
                                if not briefing_delivered:
                                    agent_speaking = True
                                    model_output_seen_in_turn = True
                                    await websocket.send_bytes(part.inline_data.data)

                    if event.turn_complete:
                        import time
                        if turn_mode == "briefing" and model_output_seen_in_turn:
                            completed_model_turns += 1
                            briefing_delivered = True
                            model_output_seen_in_turn = False
                        agent_speaking = False
                        cooldown_until = time.time() + 2.0
                        await websocket.send_json({"type": "turn_complete"})

                    if event.input_transcription and event.input_transcription.text:
                        await websocket.send_json({
                            "type": "transcript",
                            "text": event.input_transcription.text,
                            "role": "user",
                        })
                    if event.output_transcription and event.output_transcription.text:
                        output_text = event.output_transcription.text
                        if turn_mode == "briefing" and completed_model_turns >= 1:
                            continue
                        if (
                            not briefing_delivered
                            and output_text != last_output_transcript
                        ):
                            model_output_seen_in_turn = True
                            await websocket.send_json({
                                "type": "transcript",
                                "text": output_text,
                                "role": "model",
                            })
                            last_output_transcript = output_text
                            if turn_mode == "briefing" and BRIEFING_END_RE.search(output_text):
                                briefing_delivered = True
                                completed_model_turns = 1
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.error(f"send_to_browser error: {e}")

        async def session_timer():
            remaining = SESSION_TIMEOUT - (time.monotonic() - session_start)
            if remaining > 0:
                await asyncio.sleep(remaining)
            await websocket.send_json({"type": "error", "message": "Session time limit reached"})
            await websocket.close(code=1000, reason="Session timeout")

        recv_task = asyncio.create_task(receive_from_browser())
        send_task = asyncio.create_task(send_to_browser())
        timer_task = asyncio.create_task(session_timer())
        done, pending = await asyncio.wait(
            [recv_task, send_task, timer_task], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            if task.exception():
                logger.error(f"Task error: {task.exception()}")

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        async with _lock:
            _active_connections -= 1
            _connections_by_ip[client_ip] -= 1
            if _connections_by_ip[client_ip] <= 0:
                del _connections_by_ip[client_ip]
        logger.info(f"Closed {client_ip} ({_active_connections} active)")
