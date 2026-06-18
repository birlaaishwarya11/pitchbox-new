import os
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from fastapi import FastAPI, HTTPException

from storage import list_and_read_script, upload_to_tigris


ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

app = FastAPI()

client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))


@app.get("/generate-audio")
async def generate_audio():
    try:
        script_text = list_and_read_script(bucket_name="pitchbox")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    voice_id = os.getenv("VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
    model_id = "eleven_multilingual_v2"

    audio = client.text_to_speech.convert(
        text=script_text,
        voice_id=voice_id,
        model_id=model_id,
        output_format="mp3_44100_128",
    )

    audio_dir = Path(__file__).resolve().parent / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    output_path = audio_dir / "output.mp3"

    with open(output_path, "wb") as f:
        for chunk in audio:
            if chunk:
                f.write(chunk)

    uri = upload_to_tigris(
        file_path=str(output_path),
        bucket_name="pitchbox",
        object_name="output.mp3",
    )

    return {"message": "Audio generated and uploaded successfully.", "uri": uri}
