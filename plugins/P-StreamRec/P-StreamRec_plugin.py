import json
import sys
import os
import time
import logging

log = logging.getLogger("P-StreamRec")

_plugin_dir = os.path.dirname(os.path.abspath(__file__))
_SESSION_FILE = os.path.join(_plugin_dir, ".cb_session.json")
_CAM4_SESSION_FILE = os.path.join(_plugin_dir, ".cam4_session.json")

import cloudscraper
import requests

CONTEXT_URL = "https://chaturbate.com/api/chatvideocontext/"
CAM4_DIR_URL = "https://www.cam4.com/directoryCams"
CAM4_STREAM_URL = "https://www.cam4.com/rest/v1.0/profile/{}/streamInfo"
CAM4_LOGIN_URL = "https://www.cam4.com/rest/v2.0/login"
CAM4_USER_URL = "https://www.cam4.com/rest/v2.0/login/user"
CAM4_FAVORITES_URL = "https://www.cam4.com/rest/v1.0/favorites/{}/{}"
REQUEST_TIMEOUT = 15


def read_input():
    raw = sys.stdin.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def output_result(output=None, error=None):
    result = {}
    if output is not None:
        result["output"] = output
    if error is not None:
        result["error"] = error
    print(json.dumps(result))


# --- Session management ---

def _save_session(cookies_dict, username="", password=""):
    try:
        existing = {}
        if os.path.exists(_SESSION_FILE):
            with open(_SESSION_FILE) as f:
                existing = json.load(f)
        data = {
            "cookies": cookies_dict,
            "username": username or existing.get("username", ""),
            "password": password or existing.get("password", ""),
            "ts": time.time(),
        }
        with open(_SESSION_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning("Could not save session: %s", e)


def _load_session_data():
    if not os.path.exists(_SESSION_FILE):
        return None
    try:
        with open(_SESSION_FILE) as f:
            return json.load(f)
    except Exception:
        return None


def _load_session():
    data = _load_session_data()
    if not data:
        return None
    cookies = data.get("cookies")
    if cookies and cookies.get("sessionid"):
        return cookies
    return None


def _ensure_session():
    data = _load_session_data()
    if not data:
        return None
    cookies = data.get("cookies")
    if cookies and cookies.get("sessionid"):
        return cookies
    username = data.get("username", "")
    password = data.get("password", "")
    if username and password:
        result = do_login(username, password)
        if result.get("sessionid"):
            return _load_session()
    return None


def _clear_session():
    if os.path.exists(_SESSION_FILE):
        try:
            os.remove(_SESSION_FILE)
        except Exception:
            pass


# --- Login ---

def do_login(username, password):
    try:
        scraper = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "darwin", "mobile": False}
        )
        r = scraper.get("https://chaturbate.com/auth/login/", timeout=REQUEST_TIMEOUT)
        if r.status_code != 200:
            return {"error": f"Cannot access login page (HTTP {r.status_code})"}

        csrftoken = scraper.cookies.get("csrftoken", "")
        if not csrftoken:
            return {"error": "Cannot retrieve CSRF token"}

        login_data = {
            "username": username,
            "password": password,
            "csrfmiddlewaretoken": csrftoken,
            "next": "/",
        }
        headers = {
            "Referer": "https://chaturbate.com/auth/login/",
            "Origin": "https://chaturbate.com",
        }
        r2 = scraper.post(
            "https://chaturbate.com/auth/login/",
            data=login_data,
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )

        sessionid = scraper.cookies.get("sessionid", "")
        if sessionid:
            all_cookies = dict(scraper.cookies)
            _save_session(all_cookies, username, password)
            return {"sessionid": sessionid}

        if "your username and password" in r2.text.lower() or "incorrect" in r2.text.lower():
            return {"error": "Invalid credentials"}

        return {"error": "Login failed — please try again"}

    except Exception as e:
        return {"error": f"Login error: {e}"}


# --- Chaturbate Rooms ---

def _make_scraper(cookies_dict):
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "darwin", "mobile": False}
    )
    for name, value in cookies_dict.items():
        scraper.cookies.set(name, value)
    return scraper


def _parse_rooms(rooms, is_online=True):
    result = []
    for room in rooms:
        seconds_online = 0
        start_ts = room.get("start_timestamp")
        if start_ts:
            seconds_online = max(0, int(time.time()) - int(start_ts))

        result.append({
            "username": room.get("username", ""),
            "display_name": room.get("display_name", room.get("username", "")),
            "age": room.get("display_age", room.get("age", 0)),
            "gender": room.get("gender", ""),
            "country": room.get("location", ""),
            "subject": room.get("room_subject", ""),
            "viewers": room.get("num_users", 0),
            "tags": room.get("tags", []),
            "img_url": room.get("img", ""),
            "is_hd": room.get("is_hd", room.get("current_show", "") == "private"),
            "is_new": room.get("is_new", False),
            "seconds_online": seconds_online,
            "is_online": is_online,
            "num_followers": room.get("num_followers", 0),
        })
    return result


def fetch_follows(cookies_dict, page=1, page_size=60):
    try:
        scraper = _make_scraper(cookies_dict)

        online_rooms = []
        offset = 0
        while True:
            resp = scraper.get(
                "https://chaturbate.com/api/ts/roomlist/room-list/",
                params={"follow": "true", "limit": 100, "offset": offset},
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                break
            data = resp.json()
            batch = _parse_rooms(data.get("rooms", []), is_online=True)
            online_rooms.extend(batch)
            if len(batch) < 100:
                break
            offset += 100

        offline_rooms = []
        offset = 0
        while True:
            resp = scraper.get(
                "https://chaturbate.com/api/ts/roomlist/room-list/",
                params={"follow": "true", "offline": "true", "limit": 100, "offset": offset},
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                break
            data = resp.json()
            batch = _parse_rooms(data.get("rooms", []), is_online=False)
            offline_rooms.extend(batch)
            if len(batch) < 100:
                break
            offset += 100

        all_rooms = online_rooms + offline_rooms
        total = len(all_rooms)

        start = (page - 1) * page_size
        end = start + page_size
        return {"rooms": all_rooms[start:end], "total": total}

    except Exception as e:
        return {"rooms": [], "total": 0, "error": str(e)}


def toggle_follow(cookies_dict, username, action="follow"):
    try:
        scraper = _make_scraper(cookies_dict)
        csrf = cookies_dict.get("csrftoken", "")
        headers = {
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": csrf,
            "Referer": f"https://chaturbate.com/{username}/",
        }
        url = f"https://chaturbate.com/follow/{action}/{username}/"
        resp = scraper.post(url, headers=headers, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            return resp.json()
        return {"error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"error": str(e)}


def fetch_online_rooms(gender="f", page=1, page_size=60):
    try:
        scraper = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "darwin", "mobile": False}
        )
        url = "https://chaturbate.com/api/ts/roomlist/room-list/"
        params = {
            "genders": gender,
            "limit": page_size,
            "offset": (page - 1) * page_size,
        }
        resp = scraper.get(url, params=params, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            rooms = _parse_rooms(data.get("rooms", []), is_online=True)
            total = data.get("total_count", 0)
            return {"rooms": rooms, "total": total}
        else:
            return {"rooms": [], "total": 0, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"rooms": [], "total": 0, "error": str(e)}


def get_stream_url(username):
    try:
        resp = requests.get(f"{CONTEXT_URL}{username}/", timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "hls_source": data.get("hls_source", ""),
                "status": data.get("room_status", "unknown"),
            }
        return {"hls_source": "", "status": "error"}
    except Exception as e:
        return {"hls_source": "", "status": "error", "error": str(e)}


def check_performers_status(usernames):
    results = {}
    for username in usernames:
        try:
            resp = requests.get(f"{CONTEXT_URL}{username}/", timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                status = data.get("room_status", "unknown")
                hls = data.get("hls_source", "")
                results[username] = {
                    "is_online": status == "public" and bool(hls),
                    "room_status": status,
                    "hls_source": hls,
                }
            else:
                results[username] = {"is_online": False, "room_status": "error", "hls_source": ""}
        except Exception:
            results[username] = {"is_online": False, "room_status": "error", "hls_source": ""}
        time.sleep(0.3)
    return results


# --- Cam4 Session ---

def _cam4_save_session(cookies_dict, username="", password=""):
    try:
        data = {
            "cookies": cookies_dict,
            "username": username,
            "password": password,
            "ts": time.time(),
        }
        with open(_CAM4_SESSION_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning("Could not save Cam4 session: %s", e)


def _cam4_load_session_data():
    if not os.path.exists(_CAM4_SESSION_FILE):
        return None
    try:
        with open(_CAM4_SESSION_FILE) as f:
            return json.load(f)
    except Exception:
        return None


def _cam4_load_session():
    data = _cam4_load_session_data()
    if not data:
        return None
    cookies = data.get("cookies")
    if cookies and cookies.get("JSESSIONID"):
        return cookies
    return None


def _cam4_ensure_session():
    data = _cam4_load_session_data()
    if not data:
        return None
    cookies = data.get("cookies")
    if cookies and cookies.get("JSESSIONID"):
        return cookies
    username = data.get("username", "")
    password = data.get("password", "")
    if username and password:
        result = cam4_do_login(username, password)
        if result.get("success"):
            return _cam4_load_session()
    return None


def _cam4_clear_session():
    if os.path.exists(_CAM4_SESSION_FILE):
        try:
            os.remove(_CAM4_SESSION_FILE)
        except Exception:
            pass


def cam4_do_login(username, password):
    try:
        session = requests.Session()
        session.get("https://www.cam4.com/", timeout=REQUEST_TIMEOUT)
        resp = session.post(
            CAM4_LOGIN_URL,
            json={"username": username, "password": password},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code == 200:
            all_cookies = dict(session.cookies)
            user_resp = session.get(CAM4_USER_URL, timeout=REQUEST_TIMEOUT)
            cam4_username = username
            if user_resp.status_code == 200:
                user_data = user_resp.json()
                cam4_username = user_data.get("username") or username
            _cam4_save_session(all_cookies, cam4_username, password)
            return {"success": True, "username": cam4_username}
        else:
            try:
                err = resp.json()
                return {"error": err.get("details", err.get("status", f"HTTP {resp.status_code}"))}
            except Exception:
                return {"error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"error": f"Cam4 login error: {e}"}


def _cam4_make_session(cookies_dict):
    session = requests.Session()
    for name, value in cookies_dict.items():
        session.cookies.set(name, value)
    return session


def cam4_fetch_follows(cookies_dict):
    try:
        data = _cam4_load_session_data()
        username = data.get("username", "") if data else ""
        if not username:
            return {"rooms": [], "total": 0, "error": "Username not found in session"}
        session = _cam4_make_session(cookies_dict)
        resp = session.get(
            CAM4_DIR_URL,
            params={
                "directoryJson": "true",
                "favorites": "true",
                "resultsPerPage": 100,
                "page": 1,
            },
            timeout=REQUEST_TIMEOUT,
        )
        rooms = []
        if resp.status_code == 200:
            room_data = resp.json()
            if isinstance(room_data, list):
                rooms = _parse_cam4_rooms(room_data)
            elif isinstance(room_data, dict):
                room_list = room_data.get("results", room_data.get("rooms", []))
                rooms = _parse_cam4_rooms(room_list)
        return {"rooms": rooms, "total": len(rooms)}
    except Exception as e:
        return {"rooms": [], "total": 0, "error": str(e)}


def cam4_check_follow(cookies_dict, performer):
    try:
        data = _cam4_load_session_data()
        username = data.get("username", "") if data else ""
        if not username:
            return {"following": False}
        session = _cam4_make_session(cookies_dict)
        resp = session.get(
            CAM4_FAVORITES_URL.format(username, performer),
            timeout=REQUEST_TIMEOUT,
        )
        return {"following": resp.status_code == 200}
    except Exception:
        return {"following": False}


def cam4_toggle_follow(cookies_dict, performer, action="follow"):
    try:
        data = _cam4_load_session_data()
        username = data.get("username", "") if data else ""
        if not username:
            return {"error": "Not connected"}
        session = _cam4_make_session(cookies_dict)
        url = CAM4_FAVORITES_URL.format(username, performer)
        if action == "follow":
            resp = session.put(url, timeout=REQUEST_TIMEOUT)
        else:
            resp = session.delete(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code in (200, 201, 204):
            return {"following": action == "follow"}
        return {"error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"error": str(e)}


# --- Cam4 Rooms ---

CAM4_GENDER_MAP = {
    "f": "FEMALE",
    "m": "MALE",
    "c": "COUPLE",
    "t": "TRANSSEXUAL",
}


CAM4_GENDER_NORMALIZE = {
    "female": "f", "male": "m", "couple": "c", "transsexual": "t",
    "shemale": "t", "trans": "t",
}

CAM4_COUNTRY_MAP = {
    "US": "united states", "CA": "canada", "MX": "mexico", "GB": "united kingdom",
    "UK": "united kingdom", "DE": "germany", "FR": "france", "ES": "spain",
    "IT": "italy", "NL": "netherlands", "PL": "poland", "RO": "romania",
    "CZ": "czech", "PT": "portugal", "SE": "sweden", "NO": "norway",
    "DK": "denmark", "FI": "finland", "BE": "belgium", "AT": "austria",
    "CH": "switzerland", "IE": "ireland", "GR": "greece", "HU": "hungary",
    "HR": "croatia", "UA": "ukraine", "RU": "russia", "RS": "serbia",
    "LT": "lithuania", "LV": "latvia", "EE": "estonia", "SK": "slovakia",
    "SI": "slovenia", "BG": "bulgaria", "BR": "brazil", "CO": "colombia",
    "AR": "argentina", "CL": "chile", "PE": "peru", "VE": "venezuela",
    "EC": "ecuador", "BO": "bolivia", "UY": "uruguay", "PY": "paraguay",
    "JP": "japan", "CN": "china", "KR": "korea", "IN": "india",
    "TH": "thailand", "PH": "philippines", "ID": "indonesia", "MY": "malaysia",
    "VN": "vietnam", "TW": "taiwan", "SG": "singapore", "HK": "hong kong",
    "AU": "australia", "NZ": "new zealand", "ZA": "south africa",
}


def _parse_cam4_rooms(rooms):
    result = []
    for room in rooms:
        tags = room.get("showTags", []) or []
        broadcast_minutes = room.get("broadcastTime", 0) or 0
        raw_gender = (room.get("gender", "") or "").lower()
        raw_country = room.get("countryCode", "") or ""

        result.append({
            "username": room.get("username", ""),
            "display_name": room.get("username", ""),
            "age": room.get("age", 0) or 0,
            "gender": CAM4_GENDER_NORMALIZE.get(raw_gender, raw_gender[:1] if raw_gender else ""),
            "country": CAM4_COUNTRY_MAP.get(raw_country.upper(), raw_country.lower()),
            "subject": room.get("statusMessage", ""),
            "viewers": room.get("viewers", 0) or 0,
            "tags": tags[:5] if tags else [],
            "img_url": room.get("snapshotImageLink", ""),
            "is_hd": "hd" in (room.get("resolution", "") or "").lower(),
            "is_new": room.get("newPerformer", False),
            "seconds_online": broadcast_minutes * 60,
            "is_online": True,
            "num_followers": 0,
        })
    return result


def fetch_cam4_rooms(gender="f", page=1, page_size=60):
    try:
        cam4_gender = CAM4_GENDER_MAP.get(gender, "FEMALE")
        params = {
            "directoryJson": "true",
            "online": "true",
            "broadcastType": cam4_gender.lower(),
            "resultsPerPage": page_size,
            "page": page,
        }
        resp = requests.get(CAM4_DIR_URL, params=params, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list):
                rooms = _parse_cam4_rooms(data)
                return {"rooms": rooms, "total": len(rooms) + page_size}
            elif isinstance(data, dict):
                room_list = data.get("results", data.get("rooms", []))
                rooms = _parse_cam4_rooms(room_list)
                total = data.get("totalCount", data.get("total", len(rooms) + page_size))
                return {"rooms": rooms, "total": total}
            else:
                return {"rooms": [], "total": 0, "error": "Unexpected response format"}
        else:
            return {"rooms": [], "total": 0, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"rooms": [], "total": 0, "error": str(e)}


def cam4_get_stream_url(username):
    try:
        url = CAM4_STREAM_URL.format(username)
        resp = requests.get(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            cdn_url = data.get("cdnURL", "")
            edge_url = data.get("edgeURL", "")
            hls_preview = data.get("hlsPreviewUrl", "")
            # Prefer cdnURL (no referer needed, CORS *)
            if cdn_url:
                return {"hls_source": cdn_url, "status": "public"}
            elif hls_preview:
                return {"hls_source": hls_preview, "status": "public"}
            else:
                return {"hls_source": "", "status": "private"}
        return {"hls_source": "", "status": "error"}
    except Exception as e:
        return {"hls_source": "", "status": "error", "error": str(e)}


# --- Main ---

def main():
    input_data = read_input()
    if not input_data:
        output_result(error="No input received")
        return

    args = input_data.get("args", {})
    action = args.get("action", "")

    if action == "get_status":
        data = _load_session_data()
        if data and data.get("username"):
            has_session = bool(data.get("cookies", {}).get("sessionid"))
            output_result(output=json.dumps({
                "connected": has_session,
                "username": data.get("username", ""),
            }))
        else:
            output_result(output=json.dumps({"connected": False, "username": ""}))

    elif action == "login":
        username = args.get("username", "")
        password = args.get("password", "")
        if not username or not password:
            output_result(output=json.dumps({"error": "Username and password required"}))
            return
        result = do_login(username, password)
        output_result(output=json.dumps(result))

    elif action == "fetch_rooms":
        gender = args.get("gender", "f")
        page = args.get("page", 1)
        page_size = args.get("page_size", 60)
        result = fetch_online_rooms(gender, page, page_size)
        output_result(output=json.dumps(result))

    elif action == "get_stream":
        username = args.get("username", "")
        if not username:
            output_result(error="No username")
            return
        result = get_stream_url(username)
        output_result(output=json.dumps(result))

    elif action == "check_status":
        usernames = args.get("usernames", [])
        if not usernames:
            output_result(output=json.dumps({}))
            return
        result = check_performers_status(usernames)
        output_result(output=json.dumps(result))

    elif action == "fetch_follows":
        cookies = _ensure_session()
        if not cookies:
            output_result(output=json.dumps({"rooms": [], "total": 0, "error": "Not connected — go to settings"}))
            return
        page = args.get("page", 1)
        page_size = args.get("page_size", 60)
        result = fetch_follows(cookies, page, page_size)
        output_result(output=json.dumps(result))

    elif action == "check_follow":
        cookies = _ensure_session()
        if not cookies:
            output_result(output=json.dumps({"following": False}))
            return
        username = args.get("username", "")
        if not username:
            output_result(output=json.dumps({"following": False}))
            return
        try:
            scraper = _make_scraper(cookies)
            resp = scraper.get(
                f"https://chaturbate.com/follow/is_following/{username}/",
                headers={"Accept": "application/json", "X-Requested-With": "XMLHttpRequest"},
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 200:
                output_result(output=json.dumps(resp.json()))
            else:
                output_result(output=json.dumps({"following": False}))
        except Exception:
            output_result(output=json.dumps({"following": False}))

    elif action == "toggle_follow":
        cookies = _ensure_session()
        if not cookies:
            output_result(output=json.dumps({"error": "Not connected"}))
            return
        username = args.get("username", "")
        follow_action = args.get("follow_action", "follow")
        if not username:
            output_result(output=json.dumps({"error": "Username required"}))
            return
        result = toggle_follow(cookies, username, follow_action)
        output_result(output=json.dumps(result))

    elif action == "logout":
        _clear_session()
        output_result(output=json.dumps({"success": True}))

    # --- Cam4 actions ---

    elif action == "fetch_cam4_rooms":
        gender = args.get("gender", "f")
        page = args.get("page", 1)
        page_size = args.get("page_size", 60)
        result = fetch_cam4_rooms(gender, page, page_size)
        output_result(output=json.dumps(result))

    elif action == "cam4_get_stream":
        username = args.get("username", "")
        if not username:
            output_result(error="No username")
            return
        result = cam4_get_stream_url(username)
        output_result(output=json.dumps(result))

    elif action == "cam4_login":
        username = args.get("username", "")
        password = args.get("password", "")
        if not username or not password:
            output_result(output=json.dumps({"error": "Username and password required"}))
            return
        result = cam4_do_login(username, password)
        output_result(output=json.dumps(result))

    elif action == "cam4_logout":
        _cam4_clear_session()
        output_result(output=json.dumps({"success": True}))

    elif action == "cam4_get_status":
        data = _cam4_load_session_data()
        if data and data.get("username"):
            has_session = bool(data.get("cookies", {}).get("JSESSIONID"))
            output_result(output=json.dumps({
                "connected": has_session,
                "username": data.get("username", ""),
            }))
        else:
            output_result(output=json.dumps({"connected": False, "username": ""}))

    elif action == "cam4_fetch_follows":
        cookies = _cam4_ensure_session()
        if not cookies:
            output_result(output=json.dumps({"rooms": [], "total": 0, "error": "Not connected"}))
            return
        result = cam4_fetch_follows(cookies)
        output_result(output=json.dumps(result))

    elif action == "cam4_check_follow":
        cookies = _cam4_ensure_session()
        if not cookies:
            output_result(output=json.dumps({"following": False}))
            return
        performer = args.get("username", "")
        if not performer:
            output_result(output=json.dumps({"following": False}))
            return
        result = cam4_check_follow(cookies, performer)
        output_result(output=json.dumps(result))

    elif action == "cam4_toggle_follow":
        cookies = _cam4_ensure_session()
        if not cookies:
            output_result(output=json.dumps({"error": "Not connected"}))
            return
        performer = args.get("username", "")
        follow_action = args.get("follow_action", "follow")
        if not performer:
            output_result(output=json.dumps({"error": "Username required"}))
            return
        result = cam4_toggle_follow(cookies, performer, follow_action)
        output_result(output=json.dumps(result))

    else:
        output_result(error=f"Unknown action: {action}")


if __name__ == "__main__":
    main()
