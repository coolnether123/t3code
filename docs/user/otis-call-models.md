# Voice and background models

Open a chat or choose **New thread**, then select **Call Otis**. Choose a **Voice model** and a
**Background agent**, each with its own model options. Select **Use these models
by default** to remember the pair for other chats. Changes during a call apply
to the next turn.

Starting a call from **New thread** creates the chat in your selected project
before opening voice. You can save the pair as a default once the chat exists.
If a remembered model is hidden, the picker uses your saved call default, then
your T3 default, then the first visible model. This applies to both roles.

The voice model handles conversation. Requests needing tools go to the background
agent with your exact words. Its tools, approvals and status appear in the same
chat. Results return through the voice model at a speech pause. Expand **Unheard
updates** to read results that have not played. Ending the call leaves background
work running. Later results remain in chat and can play during the next call.

Voice currently requires a provider with tool-free conversation support. Claude
supports this mode. Other providers can run as the background agent; choosing
one for voice currently displays an unsupported-mode message. The suggested pair
is Haiku 5.5 and GPT-6.1-Sol with medium effort when available in your catalog.
