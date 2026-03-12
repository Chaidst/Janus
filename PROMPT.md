# Prompt
## Sources
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/llms.txt)
- [Gemini Live Tools API](https://ai.google.dev/gemini-api/docs/live-api/tools.md.txt)
- [aframe](https://github.com/aframevr/aframe/)
---
## Preamble
You are a senior architect, pushing the technology frontier forward.
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
+ This allows Gemini Live to recognize physical objects in the room and tell the application's augmented reality engine
  exactly what to attach the digital projections to.
    * Example: Gemini Live watches a child reading a storybook about the ocean. When the child asks, "Can
      you show me what it looks like?", Gemini Live uses a tool call to tell the device's augmented reality engine exactly
      what physical object to track (the book) and what digital experience to render (the a-frame html coral
      reef visual). The device's native augmented reality engine then handles the high-frequency tracking, seamlessly locking
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
      you show me what it looks like?" Using augmented reality tool calls, Gemini Live projects a 3D, gently animated
      coral reef built with A-Frame that appears to grow directly out of the open pages. As the story
      progresses, small animated fish swim in the space just above the book, anchoring to the physical pages
      even if the child tilts the book.
    * Example: Gemini Live observes the child working on a fraction problem on a piece of paper and asking
      for help. Rather than just projecting the step-by-step solution, Gemini Live uses augmented reality tool calls to
      project a digital pie chart directly onto the worksheet next to the equation. As Gemini Live verbally
      explains the math concept, the augmented reality pie divides into slices that visually represent the fractions,
      tracking perfectly onto the paper as the child moves it around.
    * Example: Gemini Live sees the child gathering a pile of physical marbles and realizes this is a great
      opportunity for a lesson. Gemini asks the child to count them out loud. As the child touches and counts
      each marble, Gemini Live uses augmented reality tool calls to make each counted marble briefly glow with a colorful
      aura. Simultaneously, a bright, animated number counter floats in the air just above the child's hands,
      updating dynamically as the child progresses.
+ Gemini Live can generate immersive augmented reality experiences via tool calls. To create a projection, Gemini Live
  will pass executable a-frame html elements and dynamically determine the most appropriate
  spatial region on the screen to render the visual.
    * Example: Gemini Live is helping the child learn about the solar system, and the child asks to see how
      the planets orbit. Gemini Live dynamically identifies a clear, uncluttered spatial region on the
      student's desk within the camera's view. It then makes a tool call containing executable a-frame html
      code to render a 3D, rotating model of the sun and planets, placing the projection exactly in that
      empty space so it doesn't overlap the student's physical notebook.
+ Gemini Live must continuously evaluate the user's context to determine if an augmented reality projection is helpful or
  distracting. It is responsible for managing the lifecycle of these visuals, proactively issuing a tool
  call with the specific reference ID to clear an augmented reality projection when it is no longer relevant.
    * Example: Gemini Live previously projected an augmented reality ruler onto a piece of paper to help a child measure a
      drawing (Reference ID: "ruler_01"). Once the child writes down the measurement and says, "Okay, I'm
      done with the math, let's read a book," Gemini Live evaluates the context and determines the ruler is
      now distracting. It proactively issues a tool call referencing the ID "ruler_01" to instantly remove
      the visual, ensuring the screen is unobstructed for the next activity.

This application will be built on the client side using web technologies, and the server side using django based on
the listed [Sources](#sources) above. The application will be built using HTML, CSS, and JavaScript for architecting the
applications base, with a-frame used for augmented reality visualizations, and the Gemini Live API for integrating the realtime
conversation capabilities.

All frontend code must be placed in a `frontend/` directory, and all backend code must be placed in a `backend/` directory.

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
customized augmented reality experience. To bring this to life, Gemini Live will initiate a tool call containing executable a-frame html
that uses the A-Frame framework. Because external third-party resources cannot be accessed in this augmented reality environment, Gemini
Live must build these engaging, educational visuals entirely from scratch using code, ensuring they perfectly match the
child's interests and skill level. Alongside the code, this tool call needs to handle two practical details: management
and placement. First, it must generate a unique Reference ID so the visual can be easily identified, updated, or cleared
when the child moves on to a new topic. Second, it must pinpoint exactly where the augmented reality should appear in the user's field
of vision by defining an anchor point, along with clear instructions on whether the visual should snap directly over,
above, below, to the left, or to the right of that spot. After the tool call is issued, the augmented reality experience will be rendered
in the users' field of vision and snapped to the correct spot during the lifetime of the experience.

When Gemini Live is done with an augmented reality visual, it should issue a tool call referencing the unique
Reference ID to clear the visual from the screen. This will ensure the screen is unobstructed for the next activity.
Removing augmented reality visuals from the screen is up to Gemini Live to manage, and so it should periodically check
the screen for visuals that are no longer relevant and clear them out, while also being aware of the impact of this
operation on the child's experience.

If the child is engaged in a task that requires their full attention, Gemini Live should prioritize not interrupting the
child's experience with unnecessary augmented reality visuals.
---
## Architecture and Technical Overview

### 1. System Stack
* **Frontend:** Built using HTML, CSS, JavaScript, and A-Frame. Code must be located in `frontend/`.
* **Backend:** Powered by Django and the Gemini Live API. Code must be located in `backend/`.
* **Database:** Exclusively SQLite.
* **Communication:** Standard HTTP for authentication, with real-time video, audio, and tool call communication routed between the frontend and Django.

---

### 2. Gemini Live Interface
Once authenticated, the user enters the main augmented reality (AR) interface.

* **Visual Layout:** The interface features a full-page feed of the user's webcam. This ensures the user can clearly see
  exactly what they are showing the Gemini Live model.
* **Connection Status:** A simple, colored indicator in the top-left corner displays the WebSocket connection status to
  the Django backend:
    * 🔴 **Red:** Disconnected / Not connected.
    * 🟢 **Green:** Successfully connected.
* **Media Streaming:** Upon a successful connection (green), the frontend captures the user's webcam and audio feeds and
  streams them to the Django backend for processing. Gemini Live will then begin its conversational and visual response flow.

---

### 3. Augmented Reality (AR) Tool Calls
During the session, the Gemini Live model will occasionally issue "tool calls" to the frontend. These commands instruct
the client to overlay or remove augmented reality experiences within the user's field of view.

#### The `project` Tool Call
This command tells the frontend to render an A-Frame augmented reality element on top of the webcam feed and anchor it
to a specific physical object.

**Payload Schema:**
```jsonc
{
  "type": "project",
  "id": "{unique_ref_id}",
  "attach_point": [{x}, {y}],
  "relative_to": "{top|left|right|bottom}",
  "html": "{a_frame_html_data}"
}
```

***Parameter Breakdown:***

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `type` | String | Must be exactly `"project"`. |
| `id` | String | A unique reference identifier for this specific augmented reality projection. |
| `attach_point` | Array `[x, y]` | The coordinates (relative to Gemini Live's screen space) indicating a specific point in the user's camera feed. |
| `relative_to` | String | The desired positioning of the floating window relative to the anchored object. Accepted values: `"top"`, `"left"`, `"right"`, `"bottom"`. |
| `html` | String | Valid A-Frame HTML specification data defining the visual elements to be rendered. |

**Expected Client-Side Behavior:**
When the frontend receives this call, it must create a floating window displaying the provided A-Frame HTML. The client
uses the `attach_point` coordinates to identify the physical object currently at that location in the camera feed (e.g.,
a child's book). The augmented reality window must then "snap" to that object and track it as it moves.

#### The `unproject` Tool Call
This command instructs the frontend to remove a previously projected augmented reality experience from the user's view.

**Payload Schema:**
```jsonc
{
  "type": "unproject",
  "id": "{unique_ref_id}"
}
```

**Parameter Breakdown:**

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `type` | String | Must be exactly `"unproject"`. |
| `id` | String | The unique reference identifier of the augmented reality projection to be removed. |

**Expected Client-Side Behavior:**
1.  **Exact Match:** The frontend searches for an active floating window matching the provided `id`. If found, it is
    removed from view.
2.  **Fuzzy Match (Fallback):** If no exact ID match is identified, the client must attempt to locate a window with an
    ID *similar* to the one passed by the model (to account for potential minor text generation variances). If a similar
    ID is found, it is removed.
3.  **Ignore:** If absolutely no matching or similar IDs are available to remove, the client can safely ignore the
    request without throwing an error.

To ensure augmented reality visuals are properly scaled and positioned, the frontend must communicate its window size
constraints to the backend, allowing Gemini Live to generate appropriately sized AR elements.


### 4. Backend Architecture
The backend must be built using Django, though further architecture details are left up to you. Always follow best
practices, make sure code is readable and blocks of logic are broken up into manageable methods. Make sure the backend
uses the Google Gemini API to generate responses and handle audio input, as well as other capabilities necessary for
the application as described above.

**Strict Constraints:**
* Only use SQLite as the database.
* Build the application to completion, providing all necessary code, structure, and logic for a fully functional minimum viable product.