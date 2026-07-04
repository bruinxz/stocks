from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from tradingagents.db.config import DATABASE_URL
import logging

logger = logging.getLogger(__name__)

try:
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()
except Exception as e:
    logger.error(f"Error connecting to database: {e}")
    # Provide fallbacks if DB is unreachable to avoid app crashing instantly
    engine = None
    SessionLocal = None
    Base = declarative_base()

def get_db():
    if not SessionLocal:
        yield None
        return
        
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
