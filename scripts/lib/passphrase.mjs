// The release key's passphrase: RELEASE_KEY_PASSPHRASE (tests), or asked on the terminal unechoed.
export async function passphrase(question) {
  const fromEnv = process.env.RELEASE_KEY_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const { stdin, stdout } = process;
  if (!stdin.isTTY)
    throw new Error('No terminal to ask for the passphrase (set RELEASE_KEY_PASSPHRASE)');
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let answer = '';
  try {
    for await (const chunk of stdin) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return answer;
        if (char === '\u0003') throw new Error('Cancelled');
        if (char === '\u007f') answer = answer.slice(0, -1);
        else answer += char;
      }
    }
    return answer;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
  }
}
