# Bringing everything back on a new machine

When the server is lost (a dead disk, a stolen machine), the backup disk and the six-word backup passphrase bring everything back: Ilexarium with its users, settings and backup plan, and your apps with their data.

You need:

- the **backup disk** (it holds the folder `ilex-backups`);
- the **backup passphrase** (six words, from your password manager or paper).

## 1. Install Ilexarium

Install it as on the first machine (`get-ilex.sh`).

## 2. Connect the backup disk

Connect it and mount it: on the **Disks** page (create a throwaway account on the setup page first to reach it), or with `mount` in a terminal. Any place works: if it's mounted somewhere else than before, the backup plan follows it.

## 3. Bring Ilexarium back

Either in a terminal on the server:

```sh
sudo ilex-recover
```

It finds the backups on the mounted disks, asks for the passphrase, lists the backups of Ilexarium there and asks before restoring the newest (`--archive <name>` restores an older one instead). Or in the browser: on the setup page create a throwaway account, sign in, then **Backups → Restore Ilexarium from a backup disk** (through your Linux sign-in and sudo).

Either way Ilexarium stops for a minute; its database, the key that opens the secrets stored in it, the backup plan, its schedule and the passphrase come back from that backup (the browser always takes the newest). A backup of a newer Ilexarium is refused before anything changes (update this one first). If it fails midway, run it again: the backup is untouched. Then sign in with your **old account** — the throwaway one is gone.

## 4. Make the Linux accounts again

Restored files keep their owner's user **number**, not the name. The end of `ilex-recover`, and the notice on the **Backups** page, list the accounts your apps and folders belong to — there, missing, or under another name here — with the command for each missing one, for example:

```sh
sudo useradd --create-home --uid 1500 anna && sudo passwd anna
```

Put each in the groups it was in (`sudo`, or `wheel` on Arch; `docker` if it was in it).

## 5. Bring the apps back

On the **Backups** page, for each app, signed in to Linux as the account it belongs to: **Restore…** (it reads the backups from the disk) → the newest backup → **Back in place**: its folder comes back where it was. The app then shows on the **Apps** page, not running yet: **Start** starts it from its restored files.

Folders you backed up come back the same way, **Back in place**, or into a folder you choose.

## 6. Check

Start a backup with **Back up now**. When it's done, everything is backed up again from the new machine.

---

## Appendix: by hand

What `ilex-recover` does, should it ever be needed without it. Every command runs as root (`sudo -i` first).

Give this machine the passphrase and check that it opens the backups:

```sh
REPO=/mnt/usb/ilex-backups                 # where the disk is mounted, plus ilex-backups
read -rs WORDS && printf '%s\n' "$WORDS" | install -m 0400 /dev/stdin /etc/ilex/backup.passphrase && unset WORDS
mkdir -p -m 0700 /var/lib/ilex/backups/borg
export BORG_BASE_DIR=/var/lib/ilex/backups/borg BORG_PASSCOMMAND='cat /etc/ilex/backup.passphrase'
borg list --short "$REPO" | tail -3        # shows the newest backups: the passphrase is right
```

The newest backup of Ilexarium itself is the newest one holding its database dump:

```sh
PLATFORM=$(borg list --format '{archive} {comment}{NL}' "$REPO" |
  grep -F '"/var/lib/ilex/backups/platform"' | tail -1 | cut -d' ' -f1)
```

Stop Ilexarium, take back the dump, the key, the plan and its schedule (nothing else: the rest of `/etc/ilex` belongs to this machine), and restore the database into an emptied schema:

```sh
systemctl stop ilex.socket ilex-https.socket ilex
cd / && borg extract "$REPO::$PLATFORM" \
  var/lib/ilex/backups/platform etc/ilex/master.key etc/ilex/backup.json \
  etc/ilex/backup-repository.json etc/systemd/system/ilex-backup.timer.d
docker exec ilex-postgres-1 psql -v ON_ERROR_STOP=1 -q -U ilex_owner -d ilex \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker exec -i ilex-postgres-1 pg_restore --exit-on-error -U ilex_owner -d ilex \
  < /var/lib/ilex/backups/platform/ilex.dump
rm -r /var/lib/ilex/backups/platform
```

If the disk is mounted somewhere else now, change `destination` in `/etc/ilex/backup.json` and the path in `/etc/ilex/backup-repository.json`, and in the database: `UPDATE "BackupPlan" SET destination = '/new/place';`. Then run `get-ilex.sh` again (it migrates the database, gives the app its rights in it and makes the key the app's own), and turn the schedule back on:

```sh
systemctl daemon-reload
systemctl enable --now ilex-backup.timer ilex-backup-check.timer
```
