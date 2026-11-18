# Bringing everything back on a new machine

When the server is lost (a dead disk, a stolen machine), the backup disk and the six-word backup passphrase bring everything back: Ilexarium with its users, settings and backup plan, and your apps with their data. A guided version of this is planned; until then, these are the steps. They need a terminal on the new machine and take about half an hour, plus the time to copy your data back.

You need:

- the **backup disk** (it holds the folder `ilex-backups`);
- the **backup passphrase** (six words, from your password manager or paper).

Every command below runs as root (`sudo -i` first).

## 1. Install Ilexarium

Install it as on the first machine (`get-ilex.sh`), but **don't open the setup page**: your old account comes back in step 4.

## 2. Connect the backup disk

Mount it at **the same place as before** (for example `/mnt/usb`): the backup plan names that place. Then give this machine the passphrase and check that it opens the backups:

```sh
REPO=/mnt/usb/ilex-backups                 # where the disk is mounted, plus ilex-backups
read -rs WORDS && printf '%s\n' "$WORDS" | install -m 0400 /dev/stdin /etc/ilex/backup.passphrase && unset WORDS
                                           # ↑ type the six words with spaces between, then Enter
mkdir -p -m 0700 /var/lib/ilex/backups/borg
export BORG_BASE_DIR=/var/lib/ilex/backups/borg BORG_PASSCOMMAND='cat /etc/ilex/backup.passphrase'
borg list --short "$REPO" | tail -3        # shows the newest backups: the passphrase is right
```

## 3. Put Ilexarium's files back

The newest backup of Ilexarium itself is the newest one holding its database dump:

```sh
PLATFORM=$(borg list --format '{archive} {comment}{NL}' "$REPO" |
  grep -F '"/var/lib/ilex/backups/platform"' | tail -1 | cut -d' ' -f1)
echo "$PLATFORM"                           # one name: <id>-<date and time>
```

Stop Ilexarium, then take back the database dump, the key that opens the secrets stored in the database, the backup plan and its schedule. Nothing else from that backup: the rest of `/etc/ilex` belongs to this machine.

```sh
systemctl stop ilex.socket ilex-https.socket ilex   # the app and its ports (its database keeps running)
cd / && borg extract "$REPO::$PLATFORM" \
  var/lib/ilex/backups/platform etc/ilex/master.key etc/ilex/backup.json \
  etc/ilex/backup-repository.json etc/systemd/system/ilex-backup.timer.d
```

## 4. Restore the database

The dump replaces the new, empty database, as the database's owner and into an emptied schema. Sessions aren't in it: everyone signs in again.

```sh
docker exec ilex-postgres-1 psql -v ON_ERROR_STOP=1 -q -U ilex_owner -d ilex \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker exec -i ilex-postgres-1 pg_restore --exit-on-error -U ilex_owner -d ilex \
  < /var/lib/ilex/backups/platform/ilex.dump
rm -r /var/lib/ilex/backups/platform
```

## 5. Run the installer once more

Run `get-ilex.sh` again, as in step 1. It repairs what the restore can't: it brings the database up to this version, gives the app its rights in it, makes the restored key the app's own again, and starts Ilexarium. Then turn the backup schedule back on:

```sh
systemctl daemon-reload
systemctl enable --now ilex-backup.timer ilex-backup-check.timer
```

Sign in with your old account and password. The **Backups** page shows your plan and your backups.

## 6. Make the Linux accounts again

Restored files keep their owner's user **number**, not the name. Make each person's account again with the same name and the same number, in the same groups as before (`sudo`, or `wheel` on Arch; `docker` if they were in it). The backups show who owned what (still in the shell of step 2):

```sh
for a in $(borg list --short --last 20 "$REPO"); do borg list --format '{user} {uid}{NL}' "$REPO::$a"; done | sort -u
```

Then for each person, for example anna with 1000: `useradd --create-home --uid 1000 --groups sudo anna && passwd anna`. Your own account, made when the machine was set up, usually has its number already (check with `id`).

## 7. Bring the apps back

Their backups bring them back, through the Linux sign-in of the account each app belongs to. On the **Backups** page, for each app: **Restore…** (it reads the backups from the disk) → the newest backup → **Back where it was**: its folder comes back where it was. The app now shows on the **Apps** page, not running yet: **Start** starts it from its restored files.

Folders you backed up (home folders, others) come back the same way, **Back where it was**, or into a folder you choose.

## 8. Check

Start a backup with **Back up now**. When it's done, everything is backed up again from the new machine.

---

_Tested 2026-11-16 on two throwaway Debian 13 machines (`tools/vm`): the first installed and backed up by the install test (an app, navidrome, as anna); the second a fresh install with the same backup disk, brought back with these steps — the owner signs in, the backup plan and its backups are listed, navidrome restored where it was (owned by anna) and started with Update, and a new backup succeeds._
