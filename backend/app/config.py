from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    DATABASE_DIR: str = "./databases"
    ALLOWED_ORIGINS: List[str] = ["*"]
    CODE_LENGTH: int = 4
    
    class Config:
        env_file = ".env"


settings = Settings()
