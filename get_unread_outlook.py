import win32com.client
from datetime import datetime

outlook = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
inbox = outlook.GetDefaultFolder(6) # 6=Inbox
messages = inbox.Items
messages = messages.Restrict("[Unread]=true")
messages.Sort("[ReceivedTime]", True)

output = []
count = 0
for message in messages:
    try:
        if count >= 10:
            break
        subject = message.Subject or ''
        sender = message.SenderName or ''
        date = message.ReceivedTime.strftime('%Y-%m-%d %H:%M')
        body = message.Body or ''
        preview = body.replace('\r',' ').replace('\n',' ').strip()[:120]
        output.append(f"Subject: {subject}\nSender: {sender}\nDate: {date}\nPreview: {preview}\n---")
        count += 1
    except Exception as e:
        continue

with open("outlook_unread_emails.txt","w", encoding="utf-8") as f:
    f.write("\n\n".join(output))
