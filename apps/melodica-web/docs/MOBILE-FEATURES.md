# Melodica Mobile feature selection

The November 19 selection contains 79 features for Android and iPhone. The numbers refer to the original 100-choice catalog. They express product scope. Implementation and device verification are tracked separately.

Feature 39 uses LRCLIB. Select **Lyrics** on the player bar to read the song. The hosted player also searches by artist and title when an album lookup misses. It follows timed lines, shows untimed words when available and remembers the open panel across tracks. Mobile-width browser tests cover these paths. Physical-device verification is pending. [LRCLIB API](https://lrclib.net/docs)

## Build and verification

| Area | Evidence and remaining work |
| --- | --- |
| Android player and walks | An Android 15 emulator installed the debug APK, opened the packaged player, started a guest walk, recorded two simulated locations with the display off, paused GPS and saved all four fixes to the journal. A second walk on the upgraded app saved three fixes, including both screen-off fixes. A media controller read native track metadata and delivered Skip to the player. Bluetooth, spoken directions, phone calls, watch controls, widgets on physical launchers and a car dashboard still need device testing. |
| Stations, history and sharing | The WASM tests exercise Pandora seed editing, mode discovery and switching, Shuffle and the content filter using recorded response shapes. Browser tests cover all-page history search/export, per-output settings, a measured equalizer boost and uninterrupted playback when the equalizer cannot load a track. An Android listen:// link opened the named artist preview and waited for Play, with the previous walks still on the shelf. A live partner login succeeded. Full signed-in Pandora playback and changes to a real account still need verification. |
| Sessions, Rooms and games | Two separate browser players paired on a local connection, delivered a rating command and moved playback in a controlled test. Mobile uses the existing room and DJ service, Garden and crew map. The daily Conquest report compares the most recent two visits on this device. Live multi-user listening and a handoff on two physical devices remain unverified. |
| Apple platforms | The checkout includes iPhone, Apple Watch, WidgetKit and CarPlay source. The Swift files and target manifests passed structural checks on Linux. Xcode compilation, signing, physical-device tests and CarPlay entitlement approval remain open. The iPhone expects the matching web player to be published. |
| External services | For #39, the LRCLIB API returned a timed record for Judy Collins’s *Amazing Grace* from *Live at Wolf Trap*. For #73, the Pithos and pianobar approval page at `/melodica/app/device` and its `/oauth/device` destination returned HTTP 404 during verification. A local copy of the shared sign-in service passed its desktop approval tests. Deploying it still needs approval. |

## Player and sound

| ID | Feature | What the listener can do |
| --- | --- | --- |
| 01 | Lock-screen radio | Keep the station playing in your pocket. See the cover, pause, or skip from the lock screen. |
| 02 | Resume the song you left | Reopen the player at the same station and position when the current song is still available. |
| 03 | Up next | See the songs already queued by your station, in the order they will play. |
| 05 | Mini player on every screen | Keep the title, pause and skip within reach while browsing stations, rooms or walks. |
| 07 | Ten-band equalizer | Adjust the bass, mids and treble across ten frequency bands. |
| 08 | Separate Wi-Fi and cellular quality | Choose the best stream your account offers on Wi-Fi and a lighter one on mobile data. |
| 09 | Recover after losing signal | See when the player is reconnecting and hear it recover automatically when service returns. |
| 11 | Resume after a call | Choose whether radio resumes after you hang up, respecting a pause you made yourself. |
| 12 | Quiet the music for navigation | Briefly lower the music while directions are spoken, then return to your listening volume. |
| 13 | Pause when headphones disconnect | Pull out earbuds or disconnect Bluetooth and playback pauses before sound moves to the phone speaker. |
| 14 | Choose the audio output | Switch among available headphones, speakers and connected outputs from the player. |
| 15 | Sound presets for each output | Give the car, earbuds and bedside speaker their own equalizer settings. |
| 18 | Home-screen station widget | Start a favorite station from the phone’s home screen with one tap. |
| 19 | Spoken track changes | Opt in to hearing the artist and title at each change while the phone stays in your pocket. |
| 20 | Cover-colored player | Let each album cover set the colors behind the player while the controls stay readable. |

## Stations and discovery

| ID | Feature | What the listener can do |
| --- | --- | --- |
| 22 | Start a station from this track | Turn the current song or its artist into a new station without typing a search. |
| 23 | Edit station seeds | Add an artist or song to broaden a station, or remove a seed that is steering it away. |
| 25 | Change station mode | Switch among the Pandora modes available for that particular station. |
| 27 | Build your own station shuffle | Choose exactly which of your stations go into Shuffle. |
| 28 | Pin favorite stations | Keep a few stations at the top in an order you choose. |
| 29 | Station folders | Group stations into collections such as Night walks, Work or Sunday breakfast. |
| 30 | Find a station as you type | Jump to a station in a long list by entering a few letters of its name. |
| 33 | Rate a song after it ends | Give a track a thumb from the play log even after the station has moved on. |
| 34 | Find a song in your history | Search past listens by artist, title, station or date to answer “What was playing yesterday?” |
| 36 | Give a song a rest | Shelve an overplayed track for a while without giving it a permanent thumbs down. |
| 37 | Explicit-content filter | Change Pandora’s explicit-content preference from inside the player. |
| 38 | Open shared station links | Preview a listen:// artist, genre or station link and choose whether to tune in. |
| 39 | Lyrics that follow the music | Follow the current line in Now Playing for songs with licensed, time-synced lyrics. |

## Walks and record sleeves

| ID | Feature | What the listener can do |
| --- | --- | --- |
| 41 | Record a walk with the screen locked | Start once, pocket the phone and capture your private route and station tracklist in the same app. |
| 42 | Choose the walk’s station | Pick one of your own stations on the walk screen and see the song change as you move. |
| 43 | Start walking before signing in | Begin a private route immediately and match it to your listening history later if you choose. |
| 44 | Pause GPS without pausing music | Take a break or skip a stretch of the route while the station keeps playing. |
| 45 | Recover an interrupted walk | Reopen a draft after an interruption and keep the points and song changes already captured. |
| 46 | Color the route by song | See the walk as a line whose color changes at each track change. |
| 47 | Scrub the walk timeline | Move through a saved walk and see where you were and what was playing at that moment. |
| 48 | Find the block where a song started | Tap a song in the tracklist to jump straight to its spot on the route. |
| 49 | Retune to a remembered station | Open the station behind a song you heard on an earlier walk. |
| 50 | Show gaps in the GPS trace | Leave a visible break where the phone lost location so the map reflects what was actually recorded. |
| 51 | Match a GPX file to your listens | Import a timed route from another recorder and line up the songs by their play times. |
| 52 | Back up a walk with its tracklist | Export a GPX containing the route and song times so the complete record can be restored. |
| 53 | Make a record sleeve | Save the walk’s song-colored route as a cover image you can send or print. |
| 54 | Trim the start and end before sharing | Choose how much to crop around the start and finish of a shared route while keeping the original private. |
| 56 | A shelf of saved walks | Browse your walk records by cover and reopen a trip with its route and tracklist. |
| 58 | Compare two walks | See how the same route sounded on two different days, with each soundtrack alongside its route. |
| 59 | Leave a song at a public stop | In a separate walking game, contribute an original Sidewalk Stereo track to the rotation at a public stop. |

## Listening together and across devices

| ID | Feature | What the listener can do |
| --- | --- | --- |
| 61 | Tune in to a public room | Browse live rooms and join one to hear what its DJ is playing now. |
| 62 | Invite-only listening parties | Host a private room and invite specific listeners through a room link. |
| 63 | Broadcast as a solo DJ | Let friends hear the station you are playing, with you in control of the broadcast. |
| 64 | Take turns as DJ | Rotate the decks among friends, one song from each person’s station per turn. |
| 65 | See who is on deck | See the current DJ, the order of upcoming DJs and who is in the audience. |
| 66 | Request a DJ spot | Join the waiting line from your phone and see when a host or the current DJs approve you. |
| 67 | React to the room’s song | Give the broadcast a like or dislike and see the room’s response to the track. |
| 68 | Choose which rooms count in your history | Toggle listen tracking for a particular room while you are there. |
| 69 | Return to your private song | Leave a room and pick up the station and song position you left behind. |
| 70 | Rejoin the live broadcast | After a connection drop, return to where the room is playing now. |
| 71 | Use the phone as a remote | Pause, skip or rate from the couch while Melodica keeps playing on the computer. |
| 72 | Move playback between devices | Move a listening session from phone to desktop, or back, and have the old device fall silent. |
| 73 | Link a desktop player to your listening history | Enter the player’s short code on your phone to let its listens appear in your spacegho.st history. |
| 74 | Wrist controls | Show the song and give it a thumb or skip it from a watch while your phone stays in your pocket. |
| 75 | Car dashboard player | Pick favorite stations and use simple playback controls on Android Auto or CarPlay. |
| 76 | Share the song that is playing | Send the title, artist and public track link through the phone’s share sheet. |
| 77 | Share a live room | Send a link that takes someone directly to the room where you are listening. |
| 78 | Open a shared recording | Play a recording someone explicitly shared through Spaceghost Scrobbles. |
| 79 | Voice and automation shortcuts | Give your phone a shortcut such as “Play my night-walk station.” |
| 80 | Tablet keyboard controls | Use familiar pianobar keys to pause, skip and rate when a hardware keyboard is attached. |

## Listening history, Garden and games

| ID | Feature | What the listener can do |
| --- | --- | --- |
| 81 | One history across Melodica apps | Opt in to saving completed mobile listens alongside plays from your other Melodica clients on spacegho.st. |
| 82 | Last.fm and ListenBrainz connections | Choose where your listens go, including Last.fm, ListenBrainz or your own compatible ListenBrainz server. |
| 83 | Save unsent listens | Keep listens on the phone during a connection outage and submit them once when service returns. |
| 84 | A private listening session | Temporarily pause listen submissions and hide what is playing from shared activity, then switch back. |
| 88 | Listening leaderboards | See which songs, artists and listeners top the board this week or month. |
| 90 | Export your listening history | Save a portable file of your play times, titles, artists and stations. |
| 91 | Grow a garden from listening | Each artist becomes a plant. Finishing more songs by that artist helps it grow and bloom. |
| 92 | Grow shared hybrids | Opt into the shared garden and see hybrid plants appear when you and another listener play the same artist. |
| 93 | Weekly garden postcards | Save an illustrated postcard of the week’s new artists, blooms and listening milestones. |
| 94 | Garden TV | Turn the phone or tablet into an ambient garden display with album artwork and a light show. |
| 95 | Tune in from a plant | Tap a plant to start a station for its artist directly from the garden. |
| 96 | Crew Conquest map | See your crew’s listening change control of towns on the seasonal music map. |
| 97 | Find music for a town | Tap a town to see which music helps there, then open a matching station. |
| 98 | Daily Conquest report | See which towns changed hands and how the season moved since your last visit. |
