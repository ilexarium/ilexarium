# Bringing everything back on a new machine

When the server is lost (a dead disk, a stolen machine), the backup disk and the six-word backup passphrase bring everything back: this app with its users, settings and keys, every service's settings, and their data. A guided version of this is planned; until then, these are the steps. They need a terminal on the new machine, and take about half an hour plus the time to copy your data back.

You need:

- the **backup disk** (it holds the folder `laris-backups`);
- the **backup passphrase** (six words, from your password manager or paper).

Every command below runs as root (`sudo -i` first).

## 1. Install the platform

Install it as on the first machine (the install script), but **don't open the setup page yet** — its account would be replaced anyway.

## 2. Connect the backup disk

Connect it and mount it under `/mnt` or `/media` at **the same place as before** (for example `/mnt/usb`), then set two shell variables used below:

```sh
REPO=/mnt/usb/laris-backups      # where the disk is mounted, plus laris-backups
read -rs BORG_PASSPHRASE && export BORG_PASSPHRASE   # type the six words, then Enter
borg list --short "$REPO" | tail -3                  # proves the passphrase opens the backups
```

## 3. Find the newest backup of the platform

Each backup is named `<item>-<UTC time>`. The platform's are the ones holding its database dump:

```sh
PLATFORM=$(for a in $(borg list --short "$REPO"); do
  borg list "$REPO::$a" var/lib/laris/backups/platform >/dev/null 2>&1 && echo "$a"
done | tail -1)
echo "$PLATFORM"
```

## 4. Put the platform's files back

Stop the app, then restore the platform's files to where they were — the master key (it opens the services' passwords stored in the database), the backup plan and its timer, and the database dump:

```sh
systemctl stop laris                   # the app (its database keeps running)
cd / && borg extract --numeric-ids "$REPO::$PLATFORM"
echo "$BORG_PASSPHRASE" > /etc/laris/backup.passphrase
chmod 0400 /etc/laris/backup.passphrase
```

## 5. Restore the database

The dump replaces the fresh database (sessions aren't in it: everyone signs in again):

```sh
docker exec -i laris-postgres-1 pg_restore -U laris -d laris --clean --if-exists --no-owner \
  < /var/lib/laris/backups/platform/laris.dump
rm -r /var/lib/laris/backups/platform
```

Services listed in the restored database aren't running on this machine yet. Mark them as removed — their settings and passwords stay, so "Install again" brings each back with its previous settings:

```sh
docker exec laris-postgres-1 psql -U laris -d laris \
  -c "UPDATE \"Service\" SET status = 'removed' WHERE status <> 'removed';"
```

## 6. Start the app and the backup timers

```sh
systemctl start laris
systemctl daemon-reload
systemctl enable --now laris-backup.timer laris-backup-check.timer
```

Sign in with your old account and password.

## 7. Bring the services' data back, then the services

On the **Backups** page, for each service: **Restore…** → the newest backup → **Back in place**. Nothing runs yet, so nothing is stopped; the folders come back where they were. Then, on the **Services** page, **Install again** — its previous settings are filled in, and it starts on its restored data. (Immich: afterwards, restore its database in Immich, as the note after the restore says.)

Folders you backed up (home folders, others) restore **to a new folder** under `/srv/laris/restores/`; move what you need from there.

## 8. Check

Start a backup with **Back up now**. When it's done, everything is backed up again from the new machine.

---

_Tested 2026-10-14 against the development database:_ a backup made by `laris-backup run`, the platform archive found and extracted as in steps 3–4, and the dump restored with `pg_restore` into a new database (users back, sessions empty).
