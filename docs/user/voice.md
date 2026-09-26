# Voice in a chat

With an empty composer and an idle agent, choose **Start voice**. Allow microphone
access when your browser asks. Speak, then choose **Send speech**. The transcript
is sent as a normal message in the open chat. Otis reads new replies and progress
from that chat. Choose **Speak** for another message.

**Stop voice** cancels recording and playback. The chat's stop button also stops
voice and interrupts the agent. Switching chats, typing, or disconnecting ends
voice. Typed messages keep working normally. Recordings stop after one minute.

Voice currently supports the primary environment in web and desktop, including
its HTTPS remote URL. It requires the environment's local speech service and
HTTPS or localhost microphone access. Other saved environments and the native
mobile app do not yet support voice sessions. Microphone audio goes to the
environment's local speech service; there is no cloud recognition fallback.
The resulting text follows the chat's selected provider, just like typed text.
