from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import List


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    DATABASE_DIR: str = "./databases"
    # The browser app is served from this backend by default, so same-origin
    # production use does not need CORS. Cross-origin deployments must opt in.
    ALLOWED_ORIGINS: List[str] = []
    CODE_LENGTH: int = 6

    @field_validator("ALLOWED_ORIGINS")
    @classmethod
    def require_explicit_origins(cls, origins: List[str]) -> List[str]:
        if "*" in origins:
            raise ValueError("ALLOWED_ORIGINS must list explicit origins; wildcard CORS is disabled")
        return origins


settings = Settings()
