const { Keypair } = require('@stellar/stellar-sdk');
const fs = require('fs');

const kp = Keypair.random();
const envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';

if (!envContent.includes('BUNDLER_SECRET=')) {
  fs.appendFileSync('.env', `\nBUNDLER_SECRET=${kp.secret()}\n`);
  console.log(`P${kp.publicKey()}`);
} else {
  console.log('EXISTS');
}
