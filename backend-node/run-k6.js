import { exec } from 'child_process';
import path from 'path';

async function run() {
  console.log('Fetching token...');
  try {
    const res = await fetch('http://localhost:3001/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `k6-${Date.now()}@example.com`, password: 'securePassword123' })
    });
    const data = await res.json();
    const token = data.accessToken;
    if (!token) throw new Error('No token received');

    console.log('Got token, running k6...');
    const k6ExePath = path.resolve(__dirname, '../k6.exe');
    const scriptPath = path.resolve(__dirname, '../load-test/query.js');

    const k6cmd = `"${k6ExePath}" run "${scriptPath}" -e TEST_TOKEN="${token}"`;
    
    const child = exec(k6cmd);
    child.stdout.on('data', console.log);
    child.stderr.on('data', console.error);
    
    child.on('close', (code) => {
      console.log(`k6 exited with code ${code}`);
      process.exit(code);
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

setTimeout(run, 2000); // give server time to start
