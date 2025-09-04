# Requires: pip install telethon
import sys
from telethon.sync import TelegramClient

if len(sys.argv) < 4:
    print("Usage: python3 verify_session.py API_ID API_HASH PHONE")
    sys.exit(1)

api_id = int(sys.argv[1])
api_hash = sys.argv[2]
phone = sys.argv[3]

try:
    with TelegramClient(phone, api_id, api_hash) as client:
        me = client.get_me()
        if me:
            print("SESSION_ACTIVE")
        else:
            print("SESSION_INACTIVE")
except Exception:
    print("SESSION_INACTIVE")
