from sqlalchemy.orm import Session
from tradingagents.db.models import AnalysisTaskModel

def create_task(db: Session, task_id: str, ticker: str, target_date: str, status: str):
    if not db:
        return None
    db_task = AnalysisTaskModel(
        id=task_id,
        ticker=ticker,
        target_date=target_date,
        status=status
    )
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task

def update_task_status(db: Session, task_id: str, status: str, elapsed_time: float = 0.0, error: str = None):
    if not db:
        return None
    db_task = db.query(AnalysisTaskModel).filter(AnalysisTaskModel.id == task_id).first()
    if db_task:
        db_task.status = status
        if elapsed_time > 0:
            db_task.elapsed_time = elapsed_time
        if error:
            db_task.error = error
        db.commit()
        db.refresh(db_task)
    return db_task

def complete_task(db: Session, task_id: str, elapsed_time: float, decision: str, rationale: str, detail: dict):
    if not db:
        return None
    db_task = db.query(AnalysisTaskModel).filter(AnalysisTaskModel.id == task_id).first()
    if db_task:
        db_task.status = "COMPLETED"
        db_task.elapsed_time = elapsed_time
        db_task.decision = decision
        db_task.rationale = rationale
        db_task.detail = detail
        db.commit()
        db.refresh(db_task)
    return db_task

def get_task(db: Session, task_id: str):
    if not db:
        return None
    return db.query(AnalysisTaskModel).filter(AnalysisTaskModel.id == task_id).first()
