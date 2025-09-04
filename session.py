from telegram import SessionManager
from telethon.sync import TelegramClient
from telethon import errors as telethon_errors
import sys

def request_otp(api_id, api_hash, phone):
    try:
        client = TelegramClient(f'{phone}.session', api_id, api_hash)
        client.connect()
        if not client.is_user_authorized():
            print("REQUESTING_OTP")
            client.send_code_request(phone)
            print("CODE_REQUESTED")  # important for bot logs
        else:
            print("ALREADY_LOGGED_IN")
    except telethon_errors.PhoneNumberInvalidError:
        print("❌ PHONE_NUMBER_INVALID")
    except telethon_errors.FloodWaitError as e:
        print(f"❌ FLOOD_WAIT_{e.seconds} seconds")
    except telethon_errors.PhoneCodeFloodError:
        print("❌ TOO_MANY_OTP_REQUESTS")
    except telethon_errors.PhoneCodeInvalidError:
        print("❌ INVALID_OTP_CODE")
    except telethon_errors.PhoneCodeExpiredError:
        print("❌ OTP_CODE_EXPIRED")
    except Exception as e:
        print(f"❌ UNKNOWN_ERROR: {e}")
    finally:
        client.disconnect()

def verify_otp(api_id, api_hash, phone, code, password=None):
    try:
        client = TelegramClient(f'{phone}.session', api_id, api_hash)
        client.connect()
        if not client.is_user_authorized():
            try:
                client.sign_in(phone, code)
                print("SESSION_FILE_CREATED")
            except telethon_errors.SessionPasswordNeededError:
                print("NEED_2FA")
            if password:
                try:
                    client.sign_in(password=password)
                    print("SESSION_FILE_CREATED")
                except telethon_errors.PasswordHashInvalidError:
                    print("❌ WRONG_2FA_PASSWORD")
        else:
            print("ALREADY_LOGGED_IN")
    except telethon_errors.FloodWaitError as e:
        print(f"❌ FLOOD_WAIT_{e.seconds} seconds")
    except telethon_errors.PhoneCodeInvalidError:
        print("❌ INVALID_OTP_CODE")
    except telethon_errors.PhoneCodeExpiredError:
        print("❌ OTP_CODE_EXPIRED")
    except Exception as e:
        print(f"❌ UNKNOWN_ERROR: {e}")
    finally:
        client.disconnect()

# Example usage
if __name__ == "__main__":
    # Replace with your real API ID, hash, and phone before running manually
    api_id = ...
    api_hash = "..."
    phone = "+123456789"
    request_otp(api_id, api_hash, phone)
