import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function updateEnv(apiKey: string) {
    const envPath = path.join(process.cwd(), '.env')

    if (!fs.existsSync(envPath)) {
        console.error('Please create a .env file first')
        process.exit(1)
    }

    let envContent = fs.readFileSync(envPath, 'utf-8')

    if (envContent.includes('API_KEY=')) {
        envContent = envContent.replace(/API_KEY=.*/, `API_KEY="${apiKey}"`)
    } else {
        envContent += `\n\nAPI_KEY=${apiKey}\n`
    }

    fs.writeFileSync(envPath, envContent)
}

function main() {
    const apiKey = crypto.randomBytes(64).toString('base64url')
    updateEnv(apiKey)

    console.log('Generated API Key:', apiKey)
    console.log('API Key updated successfully in .env')
}

main()