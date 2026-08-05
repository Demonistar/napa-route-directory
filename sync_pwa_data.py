#!/usr/bin/env python3
"""
Pulls locations-live.json from Dropbox and writes it into this repo's data.json
in the format the Route Directory PWA expects. Run by the sync-pwa-data.yml
GitHub Action on a schedule. Exits 0 whether or not anything changed; the
workflow itself decides whether to commit based on git diff.
"""
import json
import os
import sys
import urllib.request
import urllib.error

DROPBOX_APP_KEY = os.environ["DROPBOX_APP_KEY"]
DROPBOX_REFRESH_TOKEN = os.environ["DROPBOX_REFRESH_TOKEN"]
DROPBOX_LIVE_PATH = "/Delivery Optimization/Delivery Walk Through Videos/NAPA Admin Data/locations-live.json"


def get_access_token() -> str:
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": DROPBOX_REFRESH_TOKEN,
        "client_id": DROPBOX_APP_KEY,
    }).encode()
    req = urllib.request.Request("https://api.dropboxapi.com/oauth2/token", data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


def download_live_json(access_token: str) -> dict:
    req = urllib.request.Request(
        "https://content.dropboxapi.com/2/files/download",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Dropbox-API-Arg": json.dumps({"path": DROPBOX_LIVE_PATH}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print("locations-live.json not found in Dropbox yet — nothing to sync.")
            sys.exit(0)
        raise


def to_pwa_shape(dropbox_data: dict) -> dict:
    locations = []
    for loc in dropbox_data.get("locations", []):
        locations.append({
            "id": loc.get("id", ""),
            "name": loc.get("siteName", ""),
            "accountNumber": loc.get("accountNumber", ""),
            "address": loc.get("address", ""),
            "city": loc.get("city", ""),
            "state": loc.get("state", ""),
            "zip": "",
            "notes": loc.get("instructions", ""),
            "videoUrl": loc.get("videoUrl", ""),
        })
    return {
        "updated": dropbox_data.get("publishedAt", "")[:10],
        "locations": locations,
    }


def main():
    access_token = get_access_token()
    dropbox_data = download_live_json(access_token)
    pwa_data = to_pwa_shape(dropbox_data)

    with open("data.json", "w") as f:
        json.dump(pwa_data, f, indent=2)
        f.write("\n")

    print(f"Wrote {len(pwa_data['locations'])} locations to data.json")


if __name__ == "__main__":
    import urllib.parse
    main()
