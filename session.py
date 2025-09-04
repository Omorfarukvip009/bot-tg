# session.py
import sys
import asyncio
import json
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError

HASH_FILE = "phone_hash.json"

def save_hash(phone, phone_code_hash):
    try:
        data = json.load(open(HASH_FILE, "r"))
    except FileNotFoundError:
        data = {}
    data[phone] = phone_code_hash
    with open(HASH_FILE, "w") as f:
        json.dump(data, f)

def load_hash(phone):
    try:
        data = json.load(open(HASH_FILE, "r"))
        return data.get(phone)
    except FileNotFoundError:
        return None

async def main():
    if len(sys.argv) < 5:
        print("Usage:")
        print("  Step 1: python3 session.py api_id api_hash phone request")
        print("  Step 2: python3 session.py api_id api_hash phone otp=<code>")
        print("  Step 3: python3 session.py api_id api_hash phone otp=<code> password=<2fa>")
        sys.exit(1)

    api_id = int(sys.argv[1])
    api_hash = sys.argv[2]
    phone = sys.argv[3]
    args = sys.argv[4:]

    client = TelegramClient(f"{phone}.session", api_id, api_hash)
    await client.connect()

    # STEP 1: Request OTP
    if args[0] == "request":
        sent_code = await client.send_code_request(phone)
        save_hash(phone, sent_code.phone_code_hash)
        print("CODE_REQUESTED")
        print(f"phone_code_hash={sent_code.phone_code_hash}")
        await client.disconnect()
        return

    # STEP 2 / 3: OTP (+ optional password)
    otp = None
    password = None
    for a in args:
        if a.startswith("otp="):
            otp = a.split("=")[1]
        if a.startswith("password="):
            password = a.split("=")[1]

    phone_code_hash = load_hash(phone)
    if not phone_code_hash:
        print("ERROR: phone_code_hash not found. Run request step first.")
        await client.disconnect()
        return

    try:
        if otp:
            await client.sign_in(phone, otp, phone_code_hash=phone_code_hash)
    except SessionPasswordNeededError:
        if password:
            await client.sign_in(password=password)
        else:
            print("NEED_2FA")
            await client.disconnect()
            return

    print(f"SESSION_FILE={phone}.session")
    print(f"STRING_SESSION={StringSession.save(client.session)}")

    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
    
