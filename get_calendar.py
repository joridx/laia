import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import win32com.client
import datetime

outlook = win32com.client.Dispatch('Outlook.Application')
namespace = outlook.GetNamespace('MAPI')

calendar = namespace.GetDefaultFolder(9)  # 9 = Calendar
items = calendar.Items
items.Sort('[Start]', True)
items.IncludeRecurrences = True

# Get tomorrow's date
tomorrow = datetime.date.today() + datetime.timedelta(days=1)
restriction = f"[Start] >= '{tomorrow.strftime('%Y-%m-%d')} 00:00' AND [Start] < '{(tomorrow + datetime.timedelta(days=1)).strftime('%Y-%m-%d')} 00:00'"
appointments = items.Restrict(restriction)

print(f"Tomorrow's meetings ({tomorrow.strftime('%Y-%m-%d')}):")
print()

if appointments.Count == 0:
    print("No meetings scheduled for tomorrow.")
else:
    for i in range(appointments.Count):
        appt = appointments.Item(i + 1)
        start_time = appt.Start.strftime('%H:%M')
        end_time = appt.End.strftime('%H:%M')
        subject = getattr(appt, 'Subject', 'No Subject')
        location = getattr(appt, 'Location', '')
        required_attendees = getattr(appt, 'RequiredAttendees', '')
        
        print(f"{i+1}. {start_time}-{end_time}: {subject}")
        if location:
            print(f"   Location: {location}")
        if required_attendees:
            print(f"   Attendees: {required_attendees}")
        print()
