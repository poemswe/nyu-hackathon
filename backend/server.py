"""
FastAPI + WebSocket bridge for SlumlordWatch
Proxies audio/video frames between the PWA and Gemini Live via ADK run_live.

Architecture:
    Browser (PWA) <--WS--> FastAPI (this file) <--WS--> Gemini Live API
                                                    (via ADK LiveRequestQueue)
"""

import asyncio
import json
import logging
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="SlumlordWatch API")

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
    return {"status": "ok", "service": "slumlordwatch"}


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

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
            app_name="slumlordwatch",
            session_service=session_service,
        )

        session_id = f"field-{uuid.uuid4().hex[:8]}"
        session = await session_service.create_session(
            app_name="slumlordwatch",
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

        await websocket.send_json({"type": "ready"})
        logger.info(f"Session {session_id} started")

        async def receive_from_browser():
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
                        except json.JSONDecodeError:
                            pass

            except WebSocketDisconnect:
                logger.info("Browser disconnected")
            finally:
                live_request_queue.close()

        async def send_to_browser():
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
                                await websocket.send_bytes(part.inline_data.data)
                            if part.text:
                                await websocket.send_json({
                                    "type": "transcript",
                                    "text": part.text,
                                    "role": getattr(event.content, "role", "model"),
                                })

                    if event.input_transcription:
                        await websocket.send_json({
                            "type": "transcript",
                            "text": event.input_transcription,
                            "role": "user",
                        })
                    if event.output_transcription:
                        await websocket.send_json({
                            "type": "transcript",
                            "text": event.output_transcription,
                            "role": "model",
                        })
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.error(f"send_to_browser error: {e}")

        async with asyncio.TaskGroup() as tg:
            tg.create_task(receive_from_browser())
            tg.create_task(send_to_browser())

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
