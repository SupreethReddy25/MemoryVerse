import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '30s',
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
  }
};

// Replace TEST_TOKEN with a valid JWT before running
const TEST_TOKEN = __ENV.TEST_TOKEN || 'REPLACE_WITH_VALID_TOKEN';

export default function() {
  const res = http.post(
    'http://localhost:3001/query/suggest',
    JSON.stringify({ text: 'when is the OS exam?' }),
    {
      headers: {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: '30s'
    }
  );
  check(res, {
    'status 200': (r) => r.status === 200,
    'response contains SSE data': (r) => r.body.includes('data:'),
  });
  sleep(0.5);
}
