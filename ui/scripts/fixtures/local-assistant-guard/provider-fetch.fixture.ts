export function providerFetchRegressionFixture() {
  fetch("https://api.openai.com/v1/chat/completions");
  axios.post("https://api.provider.example/v1/generate");
  axios("https://api.provider.example/v1/generate");
  new XMLHttpRequest();
  new EventSource("https://api.provider.example/v1/events");
  new WebSocket("wss://api.provider.example/v1/socket");
  return "https://api.anthropic.com/v1/messages";
}
