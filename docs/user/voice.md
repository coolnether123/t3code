# Voice in a chat

Open a chat on your phone's browser and select its model and thinking setting as
usual. Choose **Call Otis**, then **Start call or recover saved call**. Allow
microphone access. Wait for the ready sound before speaking.

Speech pauses send your recording automatically. **Send speech** sends it sooner.
Your words appear as a normal message in the same chat. New assistant prose is
spoken as it arrives. Code and structured data stay in the chat.

**Interrupt and speak** stops the reply and interrupts the chat's current turn.
**End call** stops voice and releases the microphone. The chat keeps working.
The chat's own stop button still interrupts its work.

Recordings save on this device, then on your PC before transcription. If the
connection fails, **Retry saved speech** resumes delivery using the same recording.
Audio without a PC acknowledgment remains queued on this device. Keep the page
open when a save fails. Reopening the same chat can recover saved speech after
a reload. Ending an offline call retains its final recording for later PC upload,
without submitting it as new work.

Navigating away detaches voice from the page. It does not hang up the saved call
or stop the chat. Return to the same chat and choose **Call Otis** to resume or end
it. Changing the normal model selector applies to your next recording. Queued
recordings retain the model selected when they were recorded.

Voice needs HTTPS or localhost microphone access and the environment's local
speech service. It uses the chat's normal permissions and provider. There is no
cloud speech-recognition fallback. Browser suspension can pause recording; samples
since the last completed local save can be lost if the device or page is killed.

The native mobile app's microphone still provides draft dictation. Use the phone
browser for calls. Native mobile calls are not available yet.
