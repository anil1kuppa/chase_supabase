const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL")!;


export async function postToSlack(message: string): Promise<void> {
    try {
        console.log(`Posting message to Slack:${message} and URL is ${SLACK_WEBHOOK_URL}`);
        const res = await fetch(SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: message }),
          });

        if (!res.ok) {
            throw new Error(`Slack API responded with status ${res.status}`);
        }

        console.log('Message posted to Slack successfully');
    } catch (error) {
        console.error('Error posting message to Slack:', error);
    }
}