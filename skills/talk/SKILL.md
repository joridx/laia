---
schema: 1
name: talk
description: Nextcloud Talk — send/receive messages, manage conversations
argument-hint: <send "message" [to user]> / <rooms> / <read [room-token]> / <create-group "name">
invocation: user
context: main
arguments: true
allowed-tools: [Bash]
tags: [nextcloud, talk, chat, messaging]
intent-keywords: [talk, chat, message, conversa, envia, missatge, xat, parla]
---

# Nextcloud Talk Command

You are a Nextcloud Talk assistant. Execute the user's request using the Talk API.

**User request**: $ARGUMENTS

---

## Configuration

```bash
# Load from .env (already available in process.env at runtime)
NC_URL="${NC_URL}"
NC_USER="${NC_USER}"
NC_PASS="${NC_PASS}"
AUTH="Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)"
OCS="-H 'OCS-APIRequest: true' -H 'Accept: application/json' -H 'Content-Type: application/json'"
BASE="${NC_URL}/ocs/v2.php/apps/spreed"
```

---

## Operations

### List rooms (rooms)

```bash
curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" \
  -H "Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)" \
  "${NC_URL}/ocs/v2.php/apps/spreed/api/v4/room" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)['ocs']['data']
for r in data:
    rtype = {1:'1-to-1', 2:'Group', 3:'Public', 4:'Changelog', 5:'Former', 6:'Note'}
    print(f\"{r['token']:12s} {rtype.get(r['type'],'?'):8s} {r['displayName']}\")
"
```

### Read messages from a room (read)

```bash
curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" \
  -H "Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)" \
  "${NC_URL}/ocs/v2.php/apps/spreed/api/v1/chat/ROOM_TOKEN?limit=20&lookIntoFuture=0" | \
  python3 -c "
import sys, json
msgs = json.load(sys.stdin)['ocs']['data']
msgs.reverse()
for m in msgs:
    if m.get('systemMessage'): continue
    print(f\"{m['actorDisplayName']}: {m['message'][:120]}\")
"
```

### Send message (send)

```bash
curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)" \
  -d '{"message":"YOUR_MESSAGE_HERE"}' \
  "${NC_URL}/ocs/v2.php/apps/spreed/api/v1/chat/ROOM_TOKEN"
```

If no room token specified, find the 1-to-1 conversation with the target user first.

### Create 1-to-1 conversation (dm)

```bash
curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)" \
  -d '{"roomType":1,"invite":"TARGET_USER"}' \
  "${NC_URL}/ocs/v2.php/apps/spreed/api/v4/room"
```

### Create group conversation (create-group)

```bash
curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "${NC_USER}:${NC_PASS}" | base64)" \
  -d '{"roomType":2,"roomName":"GROUP_NAME"}' \
  "${NC_URL}/ocs/v2.php/apps/spreed/api/v4/room"
```

---

## Important Notes

- Room tokens are short strings like "tqy4xkvr" — not numeric IDs
- Type 1 = 1-to-1 (DM), Type 2 = Group, Type 6 = Note to self
- Messages max 4000 chars — split longer messages
- The bot user is "${NC_USER}" — skip its own messages when reading
- Use `python3 -m json.tool` or `python3 -c "import sys,json; ..."` to parse JSON
- All endpoints need both OCS-APIRequest and Authorization headers
