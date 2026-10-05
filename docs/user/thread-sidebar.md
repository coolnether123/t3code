# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Copy chats

On web and desktop, choose **Copy chat** in the chat header to copy its full
transcript. On a narrow screen, open **Task actions** first. Saved chats load
earlier history before copying. Drafts copy their current text.

To copy several chats, select them in the sidebar with `Cmd`-click on macOS or
`Ctrl`-click on Windows and Linux. Use `Shift`-click for a range. Right-click
the selection and choose **Copy chats**, followed by the selected count.
T3 loads every selected chat's history and copies one text document in sidebar
order, with a title and separator for each chat.

If a chat cannot load or the clipboard rejects the write, no partial batch is
copied. Your selection stays available to retry. Chats you select while copying
are not removed from the selection when the earlier batch finishes.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
