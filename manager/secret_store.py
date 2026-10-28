"""Client secret storage.

Windows: encrypted with DPAPI (CryptProtectData), bound to the current Windows user; the stored value
is useless on another account or machine. macOS / Linux: in the OS keychain via keyring (macOS
Keychain, Secret Service), with only a "keyring:" marker in tenants.json. Without a usable keyring
backend the secret is stored base64-encoded (tenants.json is chmod 600).

Secrets are saved under a keychain service name of their own; one saved by the 1.x Manager (service
"prisma-sdwan-manager") is still read, so tenants added in 1.x keep working. Windows uses the same DPAPI
entropy as 1.x.
"""
import base64
import sys

SERVICE = "prisma-sdwan-manager-2"  # keychain item name; the account is the TSG ID
SERVICE_1X = "prisma-sdwan-manager"  # where the 1.x Manager saved secrets, read as a fallback


class SecretMissing(Exception):
    """The tenant's client secret can't be read (e.g. removed from the keychain)."""


def _b64(secret: str) -> str:
    return "b64:" + base64.b64encode(secret.encode()).decode()


def _unb64(value: str) -> str:
    return base64.b64decode(value.split(":", 1)[-1]).decode()


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32
    _ENTROPY = b"prisma-sdwan-manager"
    _UI_FORBIDDEN = 0x1

    def _blob(data: bytes) -> _Blob:
        buf = ctypes.create_string_buffer(data, len(data))
        return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))

    def _dpapi(func, data: bytes) -> bytes:
        out, entropy = _Blob(), _blob(_ENTROPY)
        if not func(ctypes.byref(_blob(data)), None, ctypes.byref(entropy), None, None, _UI_FORBIDDEN, ctypes.byref(out)):
            raise ctypes.WinError()
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(out.pbData)

    def protect(tsg_id: str, secret: str) -> str:
        return "dpapi:" + base64.b64encode(_dpapi(_crypt32.CryptProtectData, secret.encode())).decode()

    def unprotect(tsg_id: str, value: str) -> str:
        if value.startswith("dpapi:"):
            return _dpapi(_crypt32.CryptUnprotectData, base64.b64decode(value[6:])).decode()
        return _unb64(value)

    def forget(tsg_id: str) -> None:
        pass  # the secret lives only in tenants.json

else:
    import keyring
    from keyring.errors import KeyringError

    def protect(tsg_id: str, secret: str) -> str:
        # Some backends accept a secret and silently drop it (the null backend, a locked or
        # misconfigured Secret Service), so trust the keychain only if the secret reads back.
        try:
            keyring.set_password(SERVICE, tsg_id, secret)
            if keyring.get_password(SERVICE, tsg_id) == secret:
                return "keyring:"
        except KeyringError:  # no backend (e.g. Linux without Secret Service)
            pass
        return _b64(secret)

    def unprotect(tsg_id: str, value: str) -> str:
        if value != "keyring:":
            return _unb64(value)
        try:
            secret = keyring.get_password(SERVICE, tsg_id) or keyring.get_password(SERVICE_1X, tsg_id)
        except KeyringError as e:
            raise SecretMissing(f"Can't read the client secret for {tsg_id} from the keychain: {e}") from e
        if secret is None:
            raise SecretMissing(f"The client secret for {tsg_id} isn't in the keychain; enter it again in Manage tenants")
        return secret

    def forget(tsg_id: str) -> None:
        try:
            keyring.delete_password(SERVICE, tsg_id)
        except KeyringError:
            pass  # stored as b64, or already gone
