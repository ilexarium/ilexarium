# tools/vm/vm.sh — a throwaway QEMU VM for tools/vm/test-install.sh --vm (sourced by it).
# A Debian 13 cloud image (amd64 or arm64, like this machine), started with KVM and set up by
# cloud-init with an SSH key made for this run. Needs: qemu-system-<cpu>, qemu-img, KVM
# (/dev/kvm), cloud-localds (cloud-image-utils), ssh, and for arm64 the UEFI firmware
# (/usr/share/AAVMF or /usr/share/edk2). Everything it makes is in tools/vm/run/vm/.
#
# Not run yet: the machine this was written on has no KVM (it's a VM itself).

VM_DIR="$HERE/run/vm"
VM_SSH_PORT=2222
VM_IMAGE_URL_BASE=https://cloud.debian.org/images/cloud/trixie/latest

vm_cpu() {
  case "$(uname -m)" in
    x86_64) echo amd64 ;;
    aarch64) echo arm64 ;;
    *) echo "unsupported CPU: $(uname -m)" >&2; return 1 ;;
  esac
}

vm_ssh() {
  ssh -q -i "$VM_DIR/key" -p "$VM_SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 root@127.0.0.1 "$@"
}

run_in() { vm_ssh "$(printf '%q ' "$@")"; }
copy_in() {
  scp -q -i "$VM_DIR/key" -P "$VM_SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$1" "root@127.0.0.1:$2"
}

vm_start() {
  [[ -e /dev/kvm ]] || { echo 'No /dev/kvm: use --container on this machine' >&2; exit 1; }
  local cpu image base
  cpu="$(vm_cpu)"
  mkdir -p "$VM_DIR"
  base="$VM_DIR/debian-13-genericcloud-$cpu.qcow2"
  if [[ ! -f "$base" ]]; then
    echo "==> Downloading the Debian 13 cloud image ($cpu)"
    curl -fsSL --proto '=https' -o "$base.tmp" "$VM_IMAGE_URL_BASE/debian-13-genericcloud-$cpu.qcow2"
    curl -fsSL --proto '=https' -o "$VM_DIR/SHA512SUMS" "$VM_IMAGE_URL_BASE/SHA512SUMS"
    local expected actual
    expected="$(awk -v f="debian-13-genericcloud-$cpu.qcow2" '$2 == f { print $1 }' "$VM_DIR/SHA512SUMS")"
    actual="$(sha512sum "$base.tmp" | cut -d' ' -f1)"
    [[ -n "$expected" && "$expected" == "$actual" ]] || { echo 'The image’s checksum doesn’t match' >&2; exit 1; }
    mv "$base.tmp" "$base"
  fi
  image="$VM_DIR/machine.qcow2"
  rm -f "$image" "$VM_DIR/key" "$VM_DIR/key.pub" "$VM_DIR/seed.img"
  qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$image" 20G
  # A small second disk: the backup destination (formatted and mounted by cloud-init).
  qemu-img create -q -f qcow2 "$VM_DIR/backup.qcow2" 4G
  ssh-keygen -q -t ed25519 -N '' -f "$VM_DIR/key"
  cat >"$VM_DIR/user-data" <<EOF
#cloud-config
disable_root: false
ssh_authorized_keys: ["$(cat "$VM_DIR/key.pub")"]
users: [{ name: root, ssh_authorized_keys: ["$(cat "$VM_DIR/key.pub")"] }]
disk_setup: { /dev/vdb: { table_type: gpt, layout: true } }
fs_setup: [{ label: backup, filesystem: ext4, device: /dev/vdb1 }]
mounts: [[ /dev/vdb1, /mnt/backup, ext4, "defaults,nofail", "0", "2" ]]
EOF
  printf 'instance-id: ilex-test\nlocal-hostname: ilex-test\n' >"$VM_DIR/meta-data"
  cloud-localds "$VM_DIR/seed.img" "$VM_DIR/user-data" "$VM_DIR/meta-data"
  local qemu machine firmware=()
  if [[ "$cpu" == amd64 ]]; then
    qemu=qemu-system-x86_64
    machine=(-machine q35,accel=kvm -cpu host)
  else
    qemu=qemu-system-aarch64
    machine=(-machine virt,accel=kvm -cpu host)
    local code
    for code in /usr/share/AAVMF/AAVMF_CODE.fd /usr/share/edk2/aarch64/QEMU_EFI.fd /usr/share/qemu/edk2-aarch64-code.fd; do
      [[ -f "$code" ]] && firmware=(-bios "$code") && break
    done
    ((${#firmware[@]})) || { echo 'No UEFI firmware for arm64 found' >&2; exit 1; }
  fi
  echo '==> Starting the VM'
  "$qemu" "${machine[@]}" "${firmware[@]}" -smp 2 -m 3072 -display none -daemonize \
    -pidfile "$VM_DIR/qemu.pid" -serial "file:$VM_DIR/console.log" \
    -drive "file=$image,if=virtio" -drive "file=$VM_DIR/backup.qcow2,if=virtio" \
    -drive "file=$VM_DIR/seed.img,if=virtio,format=raw" \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$VM_SSH_PORT-:22" -device virtio-net-pci,netdev=net0
  vm_wait
}

vm_wait() {
  local _
  for _ in $(seq 1 120); do
    if vm_ssh 'cloud-init status --wait >/dev/null 2>&1; systemctl is-system-running --wait' >/dev/null 2>&1; then return; fi
    sleep 5
  done
  echo 'The VM did not come up (tools/vm/run/vm/console.log)' >&2
  exit 1
}

vm_restart() {
  vm_ssh 'systemctl reboot' || true
  sleep 10
  vm_wait
}

vm_cleanup() {
  if [[ "${KEEP:-0}" == 1 ]]; then
    echo "==> Left running: ssh -i $VM_DIR/key -p $VM_SSH_PORT root@127.0.0.1   (stop: kill \$(cat $VM_DIR/qemu.pid))"
    return
  fi
  if [[ -f "$VM_DIR/qemu.pid" ]]; then kill "$(cat "$VM_DIR/qemu.pid")" 2>/dev/null || true; fi
}
