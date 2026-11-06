"""Scanner wrappers. Each returns normalized :class:`sentry.models.Finding` objects."""

from .base import ScanContext, Scanner, ScannerOutput, ToolCoverage
from .gitleaks import GitleaksScanner
from .osv import OsvScanner
from .semgrep import SemgrepScanner

ALL_SCANNERS: dict[str, type[SemgrepScanner] | type[GitleaksScanner] | type[OsvScanner]] = {
    "semgrep": SemgrepScanner,
    "gitleaks": GitleaksScanner,
    "osv": OsvScanner,
}

__all__ = [
    "ALL_SCANNERS",
    "GitleaksScanner",
    "OsvScanner",
    "ScanContext",
    "Scanner",
    "ScannerOutput",
    "SemgrepScanner",
    "ToolCoverage",
]
