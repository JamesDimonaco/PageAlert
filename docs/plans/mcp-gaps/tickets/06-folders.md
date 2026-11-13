# 06: Folders in the web app and over MCP

**What to build:** Users and agents file monitors and Products under a named folder like "PC build".

**Blocked by:** 03, 05

**Status:** done

- [x] `folders` table, one level, no settings, at most 50 per user. Deleting a folder keeps what was in it. Account deletion sweeps folders.
- [x] Dashboard groups by folder, with rename, delete and "Move to folder".
- [x] `create_folder` returns an existing folder of the same name. `folderId` on create_monitor, update_monitor and create_product. `list_monitors` shows the folder.
