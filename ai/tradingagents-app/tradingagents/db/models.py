from sqlalchemy import Column, String, Float, Text, DateTime, JSON
from datetime import datetime
from tradingagents.db.database import Base

class AnalysisTaskModel(Base):
    __tablename__ = "analysis_tasks"

    id = Column(String(36), primary_key=True, index=True)
    ticker = Column(String(20), index=True)
    target_date = Column(String(20), index=True)
    status = Column(String(20))
    decision = Column(String(20), nullable=True)
    rationale = Column(Text, nullable=True)
    
    # Store full JSON or dict output
    detail = Column(JSON, nullable=True)
    
    error = Column(Text, nullable=True)
    elapsed_time = Column(Float, default=0.0)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
