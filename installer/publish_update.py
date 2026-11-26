"""Create a signing key and a manifest for a FlowForm HTTPS release channel."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from update_client import MAX_INSTALLER, https_url, version


def encoded(value):
    return base64.b64encode(value).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action",required=True)
    init = commands.add_parser("init-key")
    init.add_argument("key", type=Path)
    publish = commands.add_parser("sign")
    publish.add_argument("key", type=Path)
    publish.add_argument("installer", type=Path)
    publish.add_argument("version")
    publish.add_argument("installer_url")
    publish.add_argument("manifest", type=Path)
    args = parser.parse_args()

    if args.action == "init-key":
        key = Ed25519PrivateKey.generate()
        with os.fdopen(os.open(args.key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
            file.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()))
        print(encoded(key.public_key().public_bytes_raw()))
        return

    version(args.version)
    https_url(args.installer_url)
    size = args.installer.stat().st_size
    if not 0 < size <= MAX_INSTALLER:
        parser.error("Installer exceeds the update size limit.")
    key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
    with args.installer.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    payload = json.dumps({"product": "FlowForm", "version": args.version, "installer_url": args.installer_url,
                          "size": size, "sha256": digest}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    args.manifest.write_text(json.dumps({"payload": encoded(payload), "signature": encoded(key.sign(payload))}),
                             encoding="utf-8")

if __name__ == "__main__":
    main()

