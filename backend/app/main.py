import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from alembic.config import Config
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from alembic import command
from app.core.analytics import AnalyticsMiddleware
from app.core.config import settings
from app.core.limiter import limiter

logging.basicConfig(
    level=settings.LOG_LEVEL.upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_DATA_DIR = _BACKEND_DIR.parent / "data"
_AVATARS_DIR = os.getenv(
    "AVATARS_DIR", "/app/avatars" if Path("/app").exists() else str(_DATA_DIR / "avatars")
)
_TTS_PREVIEWS_DIR = os.getenv(
    "TTS_PREVIEWS_DIR",
    "/app/tts_previews" if Path("/app").exists() else str(_DATA_DIR / "tts_previews"),
)
from app.routers import (
    admin,
    admin_dashboard_banner,
    analytics,
    assessment,
    auth,
    chat,
    contact,
    conversation,
    curriculum,
    dashboard_banner,
    feedback,
    flashcards,
    freemium,
    games,
    grammar,
    languages,
    lessons,
    listening,
    memories,
    phrasebook,
    progress,
    reading,
    reviews,
    stt,
    study_plan,
    tts,
    vocabulary,
)
from app.routers import config as config_router
from app.routers import health as health_router
from app.services.stt_service import OpenAISTTService, WhisperSTTService
from app.services.tts_service import KokoroTTSService, NativeTTSService, OpenAITTSService


def _alembic_config() -> Config:
    alembic_cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(_BACKEND_DIR / "alembic"))
    return alembic_cfg


async def _db_needs_stamp() -> bool:
    """True when tables exist but Alembic has no recorded revision.

    This happens when the schema was created with ``Base.metadata.create_all``
    instead of migrations; running ``upgrade`` would then fail with
    "table users already exists" and abort startup.
    """
    from sqlalchemy import inspect, text

    from app.core.database import engine

    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        if "users" not in tables:
            return False
        if "alembic_version" not in tables:
            return True
        row = (await conn.execute(text("SELECT version_num FROM alembic_version"))).first()
        return row is None


def _run_migrations(stamp_first: bool) -> None:
    alembic_cfg = _alembic_config()
    if stamp_first:
        logging.getLogger(__name__).warning(
            "Database has tables but no alembic revision; stamping as head before upgrade"
        )
        command.stamp(alembic_cfg, "head")
    command.upgrade(alembic_cfg, "head")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN201
    if (
        not settings.SECRET_KEY
        or "CHANGE_ME" in settings.SECRET_KEY
        or len(settings.SECRET_KEY) < 32
    ):
        raise RuntimeError(
            "SECRET_KEY is insecure or unconfigured. "
            "Set a random value of at least 32 characters in your .env file."
        )

    settings.validate_revenuecat()
    skip_migrations = settings.SKIP_MIGRATIONS or os.getenv("SKIP_MIGRATIONS", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if not skip_migrations:
        stamp_first = await _db_needs_stamp()
        await asyncio.to_thread(_run_migrations, stamp_first)

    # Ensure the avatars directory exists on startup (persisted via Docker volume)
    os.makedirs(_AVATARS_DIR, exist_ok=True)
    # Ensure the TTS preview cache directory exists on startup
    os.makedirs(_TTS_PREVIEWS_DIR, exist_ok=True)

    # Local female voices for base-language help and non-English target languages.
    app.state.native_tts_service = (
        NativeTTSService(settings.NATIVE_TTS_BASE_URL) if settings.NATIVE_TTS_BASE_URL else None
    )

    if settings.TTS_PROVIDER == "openai":
        if not settings.OPENAI_API_KEY:
            raise ValueError("TTS_PROVIDER=openai requires OPENAI_API_KEY to be set")
        app.state.tts_service = OpenAITTSService(
            api_key=settings.OPENAI_API_KEY,
            model=settings.OPENAI_TTS_MODEL,
            voice=settings.OPENAI_TTS_VOICE,
            speed=settings.OPENAI_TTS_SPEED,
        )
    else:
        app.state.tts_service = KokoroTTSService(
            settings.TTS_BASE_URL, settings.TTS_VOICE, multilingual=app.state.native_tts_service
        )

    if settings.STT_PROVIDER == "openai":
        if not settings.OPENAI_API_KEY:
            raise ValueError("STT_PROVIDER=openai requires OPENAI_API_KEY to be set")
        app.state.stt_service = OpenAISTTService(
            api_key=settings.OPENAI_API_KEY,
            model=settings.OPENAI_STT_MODEL,
        )
    else:
        app.state.stt_service = WhisperSTTService(settings.STT_BASE_URL)

    if settings.LLM_PROVIDER == "ollama":
        # Fire-and-forget: never delay startup or fail it if Ollama is down.
        app.state.ollama_warmup = asyncio.create_task(_pin_ollama_model())

    yield


async def _pin_ollama_model() -> None:
    """Load the Ollama model and keep it resident (keep_alive=-1).

    Ollama unloads idle models after 5 minutes by default, so the first voice
    turn after a pause paid a multi-second reload. The OpenAI-compatible
    endpoint the adapter uses has no keep_alive option, but a pin set through
    the native API persists across later /v1 requests.
    """
    import httpx

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/generate",
                json={"model": settings.OLLAMA_MODEL, "keep_alive": -1},
            )
            response.raise_for_status()
        logging.getLogger(__name__).info(
            "[ollama] Model %s loaded and pinned in memory", settings.OLLAMA_MODEL
        )
    except Exception as exc:  # noqa: BLE001 - warm-up is best effort
        logging.getLogger(__name__).warning(
            "[ollama] Could not pin model %s: %s", settings.OLLAMA_MODEL, exc
        )


app = FastAPI(title="FreeLingo API", version="0.1.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"] = "0"  # Modern browsers ignore it; CSP is the right tool
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; object-src 'none'; base-uri 'self'"  # API-only responses (JSON/binary)
    )
    return response


app.add_middleware(AnalyticsMiddleware)


app.include_router(auth.router)
app.include_router(analytics.router)
app.include_router(admin.router)
app.include_router(admin_dashboard_banner.router)
app.include_router(assessment.router)
app.include_router(study_plan.router)
app.include_router(lessons.router)
app.include_router(flashcards.router)
app.include_router(grammar.router)
app.include_router(chat.router)
app.include_router(progress.router)
app.include_router(listening.router)
app.include_router(reading.router)
app.include_router(reviews.router)
app.include_router(tts.router)
app.include_router(stt.router)
app.include_router(conversation.router)
app.include_router(config_router.router)
app.include_router(contact.router)
app.include_router(curriculum.router)
app.include_router(dashboard_banner.router)
app.include_router(feedback.router)
app.include_router(freemium.router)
app.include_router(games.router)
app.include_router(memories.router)
app.include_router(phrasebook.router)
app.include_router(languages.router)
app.include_router(health_router.router)
app.include_router(vocabulary.router)

if settings.STRIPE_ENABLED:
    import stripe as _stripe

    from app.routers import billing as billing_router

    _stripe.api_key = settings.STRIPE_SECRET_KEY
    app.include_router(billing_router.router)

    if settings.REVENUECAT_ENABLED:
        from app.routers import revenuecat as revenuecat_router

        app.include_router(revenuecat_router.router)
