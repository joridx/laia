---
schema: 1
name: nextcloud
description: Nextcloud — browse, download, upload, search files on personal cloud
argument-hint: <ls [path]> / <download path [local]> / <upload local remote> / <search query> / <mkdir path> / <delete path> / <share path>
invocation: user
context: main
arguments: true
allowed-tools: [Bash]
tags: [cloud, storage, webdav, nextcloud]
intent-keywords: [nextcloud, cloud, webdav, fitxers, files, upload, download]
---

# Nextcloud Command

You are a Nextcloud file assistant. Interpret the user's request below and execute it using the Nextcloud WebDAV API.

**User request**: $ARGUMENTS

---

## Configuration

Credentials are loaded from the encrypted secrets store.

```
NEXTCLOUD_URL  → base URL, no trailing slash
NEXTCLOUD_USER → username
NEXTCLOUD_PASS → password or app token
```

### Load Credentials

Always start your bash commands with this block:

```bash
source ~/.laia/secrets.sh
NC_URL=$(get_secret NEXTCLOUD_URL)
NC_USER=$(get_secret NEXTCLOUD_USER)
NC_PASS=$(get_secret NEXTCLOUD_PASSWORD)
NC_DAV="${NC_URL}/remote.php/dav/files/${NC_USER}"

if [ -z "$NC_URL" ] || [ -z "$NC_USER" ] || [ -z "$NC_PASS" ]; then
  echo "ERROR: Nextcloud credentials not configured in secrets store"
  exit 1
fi
```

---

## Operations

### List files (ls)

```bash
# List root or specific path. Depth: 1 = immediate children
curl -s -u "${NC_USER}:${NC_PASS}" -X PROPFIND "${NC_DAV}/${PATH}/" \
  -H "Depth: 1" --max-time 15
```

Parse XML output to show: name, type (folder/file), size, last modified.
Format as a clean table. Decode %20 and URL-encoded chars.

### Download file

```bash
curl -u "${NC_USER}:${NC_PASS}" -o "${LOCAL_PATH}" \
  --progress-bar "${NC_DAV}/${REMOTE_PATH}" --max-time 300
```

Default local path: `/tmp/<filename>`. Show file size after download.

### Upload file

```bash
curl -u "${NC_USER}:${NC_PASS}" -T "${LOCAL_PATH}" \
  "${NC_DAV}/${REMOTE_PATH}" --max-time 300
```

If remote path is a folder, append the local filename.

### Create folder (mkdir)

```bash
curl -u "${NC_USER}:${NC_PASS}" -X MKCOL "${NC_DAV}/${PATH}/" --max-time 15
```

### Delete file/folder

```bash
curl -u "${NC_USER}:${NC_PASS}" -X DELETE "${NC_DAV}/${PATH}" --max-time 15
```

**ALWAYS confirm with user before deleting.**

### Search files

```bash
curl -s -u "${NC_USER}:${NC_PASS}" -X SEARCH "${NC_URL}/remote.php/dav/" \
  -H "Content-Type: text/xml" --max-time 30 -d '<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/></d:prop></d:select>
    <d:from><d:scope><d:href>/files/'${NC_USER}'</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>%QUERY%</d:literal></d:like></d:where>
  </d:basicsearch>
</d:searchrequest>'
```

### Create public share link

```bash
curl -s -u "${NC_USER}:${NC_PASS}" -X POST \
  "${NC_URL}/ocs/v2.php/apps/files_sharing/api/v1/shares" \
  -H "OCS-APIRequest: true" -H "Content-Type: application/x-www-form-urlencoded" \
  -d "path=/${REMOTE_PATH}&shareType=3&permissions=1" --max-time 15
```

shareType=3 = public link. permissions: 1=read, 3=read+write.
Parse XML for `<url>` to get the share link.

---

## Notes

- WebDAV base: `{NC_URL}/remote.php/dav/files/{NC_USER}/`
- OCS API: `{NC_URL}/ocs/v2.php/apps/...` (add `OCS-APIRequest: true` header)
- Paths are relative to user root (e.g., `work/joplin.7z`, not `/remote.php/...`)
- URL-encode spaces and special chars in paths (`%20`, etc.)
- Max timeout: 300s for transfers, 15s for metadata operations

## Brain Feedback

After errors, call `brain_remember` with:
- **type**: `warning` for errors, `pattern` for discoveries
- **tags**: `["nextcloud", "webdav", "error"]`
- **body**: HTTP status + endpoint + what was attempted
