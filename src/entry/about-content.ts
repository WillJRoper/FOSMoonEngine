export interface AboutContent {
  imageSrc: string;
  mediaEyebrow: string;
  mediaHeadline: string;
  headerEyebrow: string;
  title: string;
  subtitle: string;
  body: string[];
}

export const ABOUT_CONTENT: AboutContent = {
  imageSrc: 'assets/about-rht100-b35v30.webp',
  mediaEyebrow: 'Moon Engine',
  mediaHeadline: 'Explore Cosmic Collisions On Human Scales',
  headerEyebrow: 'About',
  title: 'What Is This Experience?',
  subtitle:
    'Moon Engine turns large scientific simulations into an interactive hands-on experience',
  body: [
    'Choose your impact parameters and see how those decisions reshape a planet.',
    'Run your own simulations of proto-planetary impacts and compare your choices with real scientific results. Can you find the right combination of parameters to form an Earth-Moon system like ours?',
    'Even the smallest changes in angle, speed, or mass can completely transform how a giant impact unfolds. See if you can find the right combination to form a Moon like ours, and uncover the hidden interplay between the initial conditions that turns planetary chaos into an Earth-Moon system.',
  ],
};
