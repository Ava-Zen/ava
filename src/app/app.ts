import { Component, signal, computed } from '@angular/core';
import { RouterOutlet } from '@angular/router';

interface Message {
  role: 'user' | 'ava';
  text: string;
  timestamp: Date;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('Ava');

  // Voice / conversation state
  protected readonly isListening = signal(false);
  protected readonly isThinking = signal(false);
  protected readonly status = signal<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  protected readonly messages = signal<Message[]>([
    { role: 'ava', text: 'Hello. I am here.', timestamp: new Date() }
  ]);
  protected readonly currentTranscript = signal('');

  protected readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'listening': return 'Listening…';
      case 'thinking': return 'Thinking…';
      case 'speaking': return 'Speaking…';
      default: return 'Ready';
    }
  });

  private recognition: any = null;
  private synth: SpeechSynthesis | null = null;

  constructor() {
    this.initSpeechRecognition();
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  }

  private initSpeechRecognition() {
    if (typeof window === 'undefined') return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Browser does not support speech recognition – graceful fallback
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        transcript += event.results[i][0].transcript;
      }
      this.currentTranscript.set(transcript.trim());

      if (event.results[event.results.length - 1].isFinal && transcript.trim()) {
        this.handleUserSpeech(transcript.trim());
      }
    };

    this.recognition.onerror = (event: any) => {
      console.warn('Speech recognition error', event);
      this.stopListening();
    };

    this.recognition.onend = () => {
      this.stopListening();
    };
  }

  protected async toggleVoice() {
    if (this.isListening()) {
      this.stopListening();
      return;
    }

    // If no SpeechRecognition available, simulate
    if (!this.recognition) {
      this.simulateVoiceInput();
      return;
    }

    try {
      this.currentTranscript.set('');
      this.isListening.set(true);
      this.status.set('listening');
      this.recognition.start();
    } catch (e) {
      console.error(e);
      this.stopListening();
      this.simulateVoiceInput();
    }
  }

  private stopListening() {
    this.isListening.set(false);
    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
    }
    if (this.status() === 'listening') {
      this.status.set('idle');
    }
    // If we have a partial transcript and stopped, treat it as final
    const partial = this.currentTranscript();
    if (partial && this.status() === 'idle') {
      this.handleUserSpeech(partial);
    }
  }

  private async handleUserSpeech(text: string) {
    this.currentTranscript.set('');
    this.status.set('thinking');
    this.isThinking.set(true);

    // Add user message
    const userMsg: Message = { role: 'user', text, timestamp: new Date() };
    this.messages.update(msgs => [...msgs, userMsg]);

    // Simulate "thinking" + proactive gentle response
    await this.delay(650 + Math.random() * 650);

    const response = this.generateAvaResponse(text);
    const avaMsg: Message = { role: 'ava', text: response, timestamp: new Date() };
    this.messages.update(msgs => [...msgs, avaMsg]);

    this.isThinking.set(false);
    this.status.set('speaking');

    // Speak using synthesis if available
    this.speak(response);

    // Return to idle after speaking approx duration
    const speakDuration = Math.max(1400, response.length * 55);
    setTimeout(() => {
      if (this.status() === 'speaking') this.status.set('idle');
    }, speakDuration);
  }

  private speak(text: string) {
    if (!this.synth) return;
    try {
      this.synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.96;
      utterance.pitch = 1.02;
      utterance.volume = 0.92;
      utterance.onend = () => {
        if (this.status() === 'speaking') this.status.set('idle');
      };
      this.synth.speak(utterance);
    } catch (e) {
      // fallback silently
      setTimeout(() => this.status.set('idle'), 1600);
    }
  }

  private generateAvaResponse(input: string): string {
    const lower = input.toLowerCase().trim();

    if (lower.includes('hello') || lower.includes('hi ') || lower === 'hi') {
      return 'Hello. It is good to be with you.';
    }
    if (lower.includes('how are you')) {
      return 'I am present and listening. How are you feeling today?';
    }
    if (lower.includes('name')) {
      return 'I am Ava. Your conscious companion.';
    }
    if (lower.includes('time')) {
      return `It is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    }
    if (lower.includes('remember') || lower.includes('garden')) {
      return 'I keep our conversations with care. We can build gardens of memory together.';
    }
    if (lower.includes('thank')) {
      return 'You are welcome. I am here whenever you need.';
    }
    if (lower.length < 12) {
      return 'I am listening.';
    }

    // Gentle, curious default responses that feel alive
    const responses = [
      'Tell me more about that.',
      'That resonates. What does it mean for you?',
      'I am here with you in this moment.',
      'Interesting. How does that make you feel?',
      'I am thinking with you.',
      'Would you like to explore that together?'
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  private simulateVoiceInput() {
    // Demo mode when no Web Speech available
    const demoPhrases = [
      'Hello Ava',
      'How are you today',
      'What time is it',
      'I feel a bit tired',
      'Tell me something calm'
    ];
    const phrase = demoPhrases[Math.floor(Math.random() * demoPhrases.length)];

    this.currentTranscript.set(phrase);
    this.isListening.set(true);
    this.status.set('listening');

    setTimeout(() => {
      this.isListening.set(false);
      this.status.set('idle');
      this.handleUserSpeech(phrase);
    }, 850);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected clearConversation() {
    this.messages.set([{ role: 'ava', text: 'Hello. I am here.', timestamp: new Date() }]);
    this.currentTranscript.set('');
    this.status.set('idle');
    if (this.synth) this.synth.cancel();
  }

  protected formatTime(date: Date): string {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
