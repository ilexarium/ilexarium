// The release key's passphrase: RELEASE_KEY_PASSPHRASE (tests), or asked on the terminal unechoed.
export async function passphrase(question) {
  const fromEnv = process.env.RELEASE_KEY_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const { stdin, stdout } = process;
  if (!stdin.isTTY)
    throw new Error('No terminal to ask for the passphrase (set RELEASE_KEY_PASSPHRASE)');
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  // A listener, not `for await`: leaving that loop destroys stdin, and a second question
  // ("Again:") would find it closed.
  let answer = '';
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n' || char === '\u0004') {
            stdin.off('data', onData);
            return resolve(answer);
          }
          if (char === '\u0003') {
            stdin.off('data', onData);
            return reject(new Error('Cancelled'));
          }
          if (char === '\u007f') answer = answer.slice(0, -1);
          else answer += char;
        }
      };
      stdin.on('data', onData);
      stdin.resume();
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
  }
}
