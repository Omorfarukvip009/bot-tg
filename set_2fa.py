# Requires: pip install telethon
import sys
from telethon.sync import TelegramClient

if len(sys.argv) < 5:
    print("Usage: python3 set_2fa.py API_ID API_HASH PHONE NEW_PASSWORD")
    sys.exit(1)

api_id = int(sys.argv[1])
api_hash = sys.argv[2]
phone = sys.argv[3]
new_password = sys.argv[4]

# Uses local "phone.session" file created by your session.py login flow
with TelegramClient(phone, api_id, api_hash) as client:
    # Edit/set 2FA password (no old password provided; succeeds when none set,
    # or when client is already authorized to change settings)
    client.edit_2fa(new_password)
    print("2FA_UPDATED")
