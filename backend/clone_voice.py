import os
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs


ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

voice = client.voices.ivc.create(
    name="Aishwarya",
    description="The voice from the user itself",
    files=["./audio/output.mp3"],
)
