"""Encrypt data published next to the web app (GitHub Pages is public): PBKDF2-SHA256 (600k, random 16-byte salt)
-> AES-256-GCM (random 12-byte IV, AAD = purpose). Same envelope as src/vault.js (the app decrypts with WebCrypto).
The passphrase comes ONLY from the environment (BOBBY_VIEW_PASSPHRASE); without it nothing is written."""
import base64, hashlib, json, os
from pathlib import Path

ITER, AAD, ENV = 600000, "bobby-balances-v1", "BOBBY_VIEW_PASSPHRASE"

class NoPassphrase(SystemExit):
    pass

def passphrase(required=True):
    p = os.environ.get(ENV, "")
    if required and len(p) < 8:
        raise NoPassphrase(f"refusing to publish: {ENV} is not set (all published data must be encrypted)")
    return p

def _key(p, salt, it):
    return hashlib.pbkdf2_hmac("sha256", p.encode(), salt, it, 32)

def seal(obj, p=None, it=ITER, aad=AAD):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    p = p if p is not None else passphrase()
    if len(p) < 8:
        raise NoPassphrase("passphrase too short")
    salt, iv = os.urandom(16), os.urandom(12)
    ct = AESGCM(_key(p, salt, it)).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode(), aad.encode())
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "alg": "AES-256-GCM", "kdf": "PBKDF2-SHA256", "it": it, "aad": aad, "salt": b(salt), "iv": b(iv), "ct": b(ct)}

def open_(env, p=None):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    p = p if p is not None else passphrase()
    d = lambda x: base64.b64decode(x)
    pt = AESGCM(_key(p, d(env["salt"]), int(env["it"]))).decrypt(d(env["iv"]), d(env["ct"]), env.get("aad", AAD).encode())
    return json.loads(pt)

def write_sealed(path, obj, p=None):
    """Seal obj and write it atomically. Refuses plaintext names: published files must end in .enc.json."""
    path = Path(path)
    if not path.name.endswith(".enc.json"):
        raise SystemExit(f"refusing to write {path.name}: published data files must be *.enc.json")
    env = seal(obj, p)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(env) + "\n")
    tmp.replace(path)
    return path

def read_sealed(path, p=None):
    return open_(json.loads(Path(path).read_text()), p)
