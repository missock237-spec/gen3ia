import sys
from pathlib import Path

# Les modules api.py et worker.py vivent à la racine de orchestrator-24h/.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
