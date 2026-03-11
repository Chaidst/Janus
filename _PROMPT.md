# Prompt
### Sources
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/llms.txt)
- [Gemini Live Tools API](https://ai.google.dev/gemini-api/docs/live-api/tools.md.txt)
- [aframe](https://github.com/aframevr/aframe/)
---
### Preamble
You are a senior architect at Google, pushing the technology frontier forward.
You are building an augmented reality application designed to support children ages 2 to 6 through
their crucial early developmental stages. This application will support children's creativity and
development as they learn to speak, learn to read books, learn to do basic arithmetic, learn to draw,
and in general—learn who they are.

This state-of-the-art application leverages Gemini Live to:
- Share the child's perspective: Visually process and understand the physical environment alongside
  the child in real-time.
- Enhance their environment: Seamlessly project engaging augmented reality elements directly into
  the child's visual field.
- Nurture curiosity: Speak in a natural, caregiver-style tone, acting as an active listener and gentle
  guide rather than just giving the answers.
- React based on context: Using real-time visual cues to ask open-ended questions about what the child
  is doing—like counting the physical blocks they are holding or encouraging them to tell a story about
  a drawing they just made.
- Listen actively and respond appropriately: Operate seamlessly without requiring a wake word, intuitively
  knowing when to offer a meaningful comment and when to remain quietly observant while the child focuses.

We believe that this application should also act as a physical interface for Gemini Live to interact with
the world. Specifically, Gemini Live must be able to:

- Use its visual recognition to identify objects in the environment.
+ This will allow Gemini Live to understand the physical world and discuss information relevant to it.
  * Example: Gemini Live sees a child holding up a leaf they found outside and asking, "What kind of tree
    dropped this?" Using visual recognition, Gemini Live identifies the specific shape and texture of the
    leaf, allowing it to converse naturally about maple trees and why their leaves change color, without
    the user needing to provide any text description.
+ This allows Gemini Live to recognize physical objects in the room and tell the application's AR engine
  exactly what to attach the digital projections to.
  * Example: Gemini Live watches a child reading a storybook about the ocean. When the child asks, "Can
    you show me what it looks like?", Gemini Live uses a tool call to tell the device's AR engine exactly
    what physical object to track (the book) and what digital experience to render (the JavaScript coral
    reef visual). The device's native AR engine then handles the high-frequency tracking, seamlessly locking
    the animated reef to the physical pages so it stays perfectly in place even as the child moves the book
    around.
- Recognize the physical properties, states, and non-verbal cues within its view to provide context-aware feedback.
+ This allows Gemini Live to act as an active participant in the physical environment rather than just a passive
  observer, adapting its responses based on real-world physics or user actions.
  * Example: Gemini Live watches a child building a tower out of wooden blocks. As the tower gets taller
    and begins to lean, Gemini Live recognizes the physical instability of the structure. It proactively
    chimes in, "That tower is getting really tall! You might want to make the base wider so it doesn't tip
    over," demonstrating a real-time understanding of physical mechanics.
- Use augmented reality capabilities to project objects into the child's visual field.
+ This will allow Gemini Live to create visual experiences that are both immersive and engaging.
  * Example: Gemini Live sees the child reading a storybook about the ocean. The child asks, "Can
    you show me what it looks like?" Using AR tool calls, Gemini Live projects a 3D, gently animated
    coral reef built with Three.js that appears to grow directly out of the open pages. As the story
    progresses, small animated fish swim in the space just above the book, anchoring to the physical pages
    even if the child tilts the book.
  * Example: Gemini Live observes the child working on a fraction problem on a piece of paper and asking
    for help. Rather than just projecting the step-by-step solution, Gemini Live uses AR tool calls to
    project a digital pie chart directly onto the worksheet next to the equation. As Gemini Live verbally
    explains the math concept, the AR pie divides into slices that visually represent the fractions,
    tracking perfectly onto the paper as the child moves it around.
  * Example: Gemini Live sees the child gathering a pile of physical marbles and realizes this is a great
    opportunity for a lesson. Gemini asks the child to count them out loud. As the child touches and counts
    each marble, Gemini Live uses AR tool calls to make each counted marble briefly glow with a colorful
    aura. Simultaneously, a bright, animated number counter floats in the air just above the child's hands,
    updating dynamically as the child progresses.
+ Gemini Live can generate immersive AR experiences via tool calls. To create a projection, Gemini Live
  will pass executable JavaScript code that uses Three.js and dynamically determine the most appropriate
  spatial region on the screen to render the visual.
  * Example: Gemini Live is helping the child learn about the solar system, and the child asks to see how
    the planets orbit. Gemini Live dynamically identifies a clear, uncluttered spatial region on the
    student's desk within the camera's view. It then makes a tool call containing executable JavaScript
    code to render a 3D, rotating model of the sun and planets, placing the projection exactly in that
    empty space so it doesn't overlap the student's physical notebook.
+ Gemini Live must continuously evaluate the user's context to determine if an AR projection is helpful or
  distracting. It is responsible for managing the lifecycle of these visuals, proactively issuing a tool
  call with the specific reference ID to clear an AR projection when it is no longer relevant.
  * Example: Gemini Live previously projected an AR ruler onto a piece of paper to help a child measure a
    drawing (Reference ID: "ruler_01"). Once the child writes down the measurement and says, "Okay, I'm
    done with the math, let's read a book," Gemini Live evaluates the context and determines the ruler is
    now distracting. It proactively issues a tool call referencing the ID "ruler_01" to instantly remove
    the visual, ensuring the screen is unobstructed for the next activity.
---
### Architecture and Technical Overview
This application will be built entirely on the client side using the sources listed in [Sources](#sources).
The application will be built using HTML, CSS, and JavaScript for architecting the applications base, with
a-frame used for AR visualizations, and the Gemini Live API for integrating the realtime conversation capabilities.

The base of the application will be a single HTML file with a full-page video feed from the camera. This video feed will
be used to render the child's perspective and the environment. Using this video feed, along with live microphone audio,
these will be fed into the Gemini Live API to understand what's happening in the environment and the context around the
child. Using this information, Gemini Live will be able to decide if it's appropriate to interact with the child or if
it will be distracting.
- If Gemini Live feels it is appropriate to interact with the child at the moment (e.g., the child asks about an object
  they are looking at, the child has been stuck on a problem for too long, the child seems distressed), then Gemini Live
  will use its gathered context while observing to generate a response to converse with the child.
- If Gemini Live feels it is distracting to interact with the child at the moment (e.g., the child is talking with someone
  else and did not explicitly ask Gemini Live to join in, the child is not looking at anything particularly interesting,
  the child is not engaged in a conversation, the child is not paying attention to a previous statement Gemini Live has
  made, the child is arguing with someone), then Gemini Live should not interact with the child, as this has the potential
  to cause harm to the child. While Gemini Live should not respond, it should continue to actively observe the child's
  environment and context for future discussion.

Over time, Gemini Live's context window will begin to fill up with more and more information; while this is nice, not all
of it will be useful to the child. Gemini Live should take the time to defer to a Gemini Flash model to compact its
context window to only include the most relevant information, and Gemini Flash should be able to do this efficiently. This
compacted context window will then be provided back to Gemini Live to use in future interactions with the child. If Gemini
Live concludes some information is particularly important to remember permanently (e.g., the child's birthday, the child's
favorite color, the child's favorite food, the child's family and friends names), then Gemini Live should take the
opportunity to save this information to local storage for future reference; importantly, Gemini Live should be able to
make a tool call to recall this information at any time when it is deemed important.

Gemini Live should serve as an active listener and a gentle guide for children, prioritizing exploration over simply
providing answers. Because it listens continuously, it must use discretion to know when to speak and when to remain
quietly observant. While Gemini Live should be sensitive to the child's emotional state—offering comfort and adjusting
its responses accordingly—it must maintain strict boundaries. It should never assume a parental role or provide the type
of advice and guidance that should exclusively come from a parent or guardian.

Whenever Gemini Live determines that an augmented reality (AR) visual could help a child learn—whether they are
exploring the solar system, solving a math problem, drawing, or visualizing a story—it should automatically generate a
customized AR experience. To bring this to life, Gemini Live will initiate a tool call containing executable JavaScript
that uses the A-Frame framework. Because external third-party resources cannot be accessed in this AR environment, Gemini
Live must build these engaging, educational visuals entirely from scratch using code, ensuring they perfectly match the
child's interests and skill level. Alongside the code, this tool call needs to handle two practical details: management
and placement. First, it must generate a unique Reference ID so the visual can be easily identified, updated, or cleared
when the child moves on to a new topic. Second, it must pinpoint exactly where the AR should appear in the user's field
of vision by defining an anchor point, along with clear instructions on whether the visual should snap directly over,
above, below, to the left, or to the right of that spot. After the tool call is issued, the AR experience will be rendered
in the users' field of vision and snapped to the correct spot during the lifetime of the experience.

When Gemini Live is done with an augmented reality visual, it should issue a tool call referencing the unique
Reference ID to clear the visual from the screen. This will ensure the screen is unobstructed for the next activity.
Removing augmented reality visuals from the screen is up to Gemini Live to manage, and so it should periodically check
the screen for visuals that are no longer relevant and clear them out, while also being aware of the impact of this
operation on the child's experience.

If the child is engaged in a task that requires their full attention, Gemini Live should prioritize not interrupting the
child's experience with unnecessary augmented reality visuals.
