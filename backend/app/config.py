from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    DATABASE_DIR: str = "./databases"
    ALLOWED_ORIGINS: List[str] = ["*"]
    CODE_LENGTH: int = 6


settings = Settings()
