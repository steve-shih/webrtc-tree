const { spawn } = require('child_process');

const npm = spawn('npm.cmd', ['login', '--auth-type=legacy'], { shell: true });

npm.stdout.on('data', (data) => {
  const str = data.toString();
  process.stdout.write(str);
  
  if (str.toLowerCase().includes('username:')) {
    npm.stdin.write('stevehy_shih113\n');
  } else if (str.toLowerCase().includes('password:')) {
    npm.stdin.write('STEVE91218457\n');
  } else if (str.toLowerCase().includes('email:')) {
    npm.stdin.write('shihcarl@gmail.com\n');
  } else if (str.toLowerCase().includes('one-time password') || str.toLowerCase().includes('otp')) {
    console.log('\n[WAITING FOR OTP] - NPM has sent the email. Please type OTP via stdin.');
  }
});

npm.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

process.stdin.on('data', (data) => {
  npm.stdin.write(data);
});

npm.on('close', (code) => {
  process.exit(code);
});
