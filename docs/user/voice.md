# Voice in a chat

Open a chat on your phone's browser and select its model and thinking setting as
usual. Choose **Call Otis**, then **Start call or recover saved call**. Allow
microphone access. Wait for the ready sound before speaking.

You can start from **New thread**. Choose a project and the call's models;
starting the call creates the chat first. If opening fails before any speech
is captured, **End call** closes the panel without leaving a recording to retry.

Speech pauses send your recording automatically. **Send speech** sends it sooner.
Your words appear as a normal message in the same chat. New assistant prose is
spoken as it arrives. Code and structured data stay in the chat.

**Interrupt and speak** stops the reply and interrupts the chat's current turn.
**End call** stops voice and releases the microphone. The chat keeps working.
The chat's own stop button still interrupts its work.

With PC recognition, recordings save on this device, then on your PC before transcription. If the
connection fails, **Retry** resumes delivery using the same recording.
Audio without a PC acknowledgment remains queued on this device. Keep the page
open when a save fails. Reopening the same chat can recover saved speech after
a reload. Ending an offline call retains its final recording for later PC upload,
without submitting it as new work.

Navigating away detaches voice from the page. It does not hang up the saved call
or stop the chat. Return to the same chat and choose **Call Otis** to resume or end
it. Changing the normal model selector applies to your next recording. Queued
recordings retain the model selected when they were recorded.

Voice needs HTTPS or localhost microphone access and the environment's local
speech service. It uses the chat's normal permissions and provider.
Phone recognition uses your device's speech service instead when PC recognition is unavailable.
On iPhone, audio goes to Apple. Phone recognition saves transcripts, without raw recordings.
Otis pauses phone recognition while speaking. If voice input is unavailable, type in the chat.
Browser suspension can pause recording; samples
since the last completed local save can be lost if the device or page is killed.

The native mobile app's microphone still provides draft dictation. Use the phone
browser for calls. Native mobile calls are not available yet.

The phone browser keeps Call Otis and the model selector visible when the text
composer is collapsed. Starting cold voice engines can take about 3 to 5 minutes;
the call waits for their readiness. You can end the call while it prepares.
After a call ends, the same chat can start a new call from any device. Saved audio
from an ended call finishes uploading before a fresh call starts.
