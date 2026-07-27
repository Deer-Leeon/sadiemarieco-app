# Appointment SMS — simple scenario list

What a **client** or **admin** can do, and the studio SMS that goes with it (when the client opted in to texts).

Example texts below use a **2 Week Fill** on **Saturday, July 25 at 10:00am**. Real sends use the real service, time, link, and fee amount.

---

## Client

### Books and saves card (confirmed)

**SMS**

```
Sadie Marie: Your 2 Week Fill is confirmed for Saturday, July 25 at 10:00am. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=EXAMPLE. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Reschedules (any way — manage link or Cal)

**SMS**

```
Sadie Marie: Your 2 Week Fill has been rescheduled to Sunday, July 26 at 2:00pm. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=EXAMPLE. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Cancels more than 24 hours before the appointment

**SMS:** none  
(Cal may still email them.)

---

### Cancels within 24 hours before the appointment (card on file, $20 fee charged)

**SMS**

```
Sadie Marie: Your 2 Week Fill on Saturday, July 25 at 10:00am was canceled. A late-cancel fee of $20 was charged to your card on file. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Cancels within 24 hours but no fee is charged (no card / charge failed)

**SMS:** none

---

### Gets the day-before reminder

**SMS** (lash/fill example)

```
Sadie Marie: Reminder — your 2 Week Fill is tomorrow at 10:00am. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Gets the one-hour reminder

**SMS** (lash/fill example)

```
Sadie Marie: Your 2 Week Fill is in one hour. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Starts booking but never finishes card / checkout

**SMS:** none  
(Hold drops; nothing to text.)

---

## Admin

### Books for a client (manual booking)

**SMS** — same confirmation as a client checkout

```
Sadie Marie: Your 2 Week Fill is confirmed for Saturday, July 25 at 10:00am. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=EXAMPLE. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Cancels an appointment

**SMS**

```
Sadie Marie: Your 2 Week Fill on Saturday, July 25 at 10:00am has been canceled. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Reschedules an appointment

**SMS** — same as client reschedule

```
Sadie Marie: Your 2 Week Fill has been rescheduled to Sunday, July 26 at 2:00pm. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=EXAMPLE. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Marks no-show — does not charge

**SMS**

```
Sadie Marie: You were marked as a no-show for your 2 Week Fill on Saturday, July 25 at 10:00am. Please reach out if you'd like to rebook. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Marks no-show — charges 50% fee

**SMS** (example: $65 = half of a $130 service)

```
Sadie Marie: You were marked as a no-show for your 2 Week Fill on Saturday, July 25 at 10:00am. A no-show fee of $65 was charged to your card on file. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

---

### Blocks studio time (not a client appointment)

**SMS:** none

---

## Quick cheat sheet

| Who | Action | SMS? |
|-----|--------|------|
| Client | Book + vault card | Confirmation |
| Client | Reschedule | Reschedule |
| Client | Cancel (early) | none |
| Client | Cancel late + $20 charged | Late-fee receipt |
| Client | Cancel late, no charge | none |
| Client | ~24h before | Reminder |
| Client | ~1h before | Reminder |
| Client | Abandon checkout | none |
| Admin | Book for client | Confirmation |
| Admin | Cancel | Cancel |
| Admin | Reschedule | Reschedule |
| Admin | No-show, no charge | No-show |
| Admin | No-show + charge | No-show + fee |
| Admin | Block time | none |

For the full technical map, see `docs/appointment-lifecycle-sms.md`.
