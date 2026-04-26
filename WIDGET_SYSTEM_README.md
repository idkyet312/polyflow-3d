# Unreal Engine Style Widget System for Three.js

This project now includes a comprehensive Unreal Engine-style widget system that creates HTML UI overlays on top of the Three.js canvas, similar to UMG (Unreal Motion Graphics) widgets.

## Key Changes

The widget system has been updated from 3D scene objects to HTML DOM elements that overlay the canvas, providing:

- **Better UI Integration**: Widgets appear as proper HTML elements over the Three.js canvas
- **Screen-Space Positioning**: Widgets use normalized screen coordinates (0-1) for positioning
- **Interactive Elements**: Buttons and other widgets can receive user input
- **CSS Styling**: Full CSS control over widget appearance and animations

## Widget Types

### TextWidget
Displays text with customizable styling.

```javascript
const textId = WidgetAPI.createWidget('text', {
    text: 'Hello World',
    fontSize: 24,
    color: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    position: { x: 0.5, y: 0.5 }, // Center of screen
    visible: true
});
```

### ProgressBarWidget
Shows progress with a fillable bar.

```javascript
const progressId = WidgetAPI.createWidget('progress', {
    progress: 0.75, // 0-1
    width: 200,
    height: 20,
    fillColor: '#00ff00',
    backgroundColor: '#333333',
    position: { x: 0.1, y: 0.8 }
});
```

### ImageWidget
Displays images with optional sizing.

```javascript
const imageId = WidgetAPI.createWidget('image', {
    imageUrl: 'path/to/image.png',
    width: 100,
    height: 100,
    position: { x: 0.8, y: 0.2 }
});
```

### ButtonWidget
Interactive buttons with click handlers.

```javascript
const buttonId = WidgetAPI.createWidget('button', {
    text: 'Click Me',
    width: 120,
    height: 40,
    backgroundColor: '#444444',
    hoverColor: '#666666',
    onClick: (widgetId) => {
        console.log('Button clicked:', widgetId);
    },
    position: { x: 0.9, y: 0.9 }
});
```

## API Reference

### WidgetAPI.createWidget(type, config)
Creates a new widget and returns its ID.

**Parameters:**
- `type`: Widget type ('text', 'image', 'progress', 'button')
- `config`: Configuration object with widget-specific properties

### WidgetAPI.updateWidget(id, updates)
Updates an existing widget's properties.

**Parameters:**
- `id`: Widget ID returned by createWidget
- `updates`: Object with properties to update

### WidgetAPI.showWidget(id, visible)
Shows or hides a widget.

**Parameters:**
- `id`: Widget ID
- `visible`: Boolean visibility state

### WidgetAPI.removeWidget(id)
Removes a widget from the UI.

**Parameters:**
- `id`: Widget ID to remove

### WidgetAPI.setWidgetPosition(id, position, space)
Sets widget position.

**Parameters:**
- `id`: Widget ID
- `position`: Position object {x, y} (normalized 0-1)
- `space`: Coordinate space ('screen' only, default)

### WidgetAPI.setWidgetScale(id, scale)
Sets widget scale.

**Parameters:**
- `id`: Widget ID
- `scale`: Scale factor (number)

## Positioning

Widgets use normalized screen coordinates:
- `{ x: 0, y: 0 }` = Top-left corner
- `{ x: 1, y: 1 }` = Bottom-right corner
- `{ x: 0.5, y: 0.5 }` = Center of screen

## Example Usage

```javascript
// Create a score display
const scoreId = WidgetAPI.createWidget('text', {
    text: 'Score: 0',
    position: { x: 0.05, y: 0.9 },
    fontSize: 20,
    color: '#ffff00',
    backgroundColor: 'rgba(0, 0, 0, 0.7)'
});

// Update the score
WidgetAPI.updateWidget(scoreId, {
    text: 'Score: 1000'
});

// Create a health bar
const healthId = WidgetAPI.createWidget('progress', {
    progress: 1.0,
    position: { x: 0.05, y: 0.8 },
    width: 200,
    height: 20
});

// Update health
WidgetAPI.updateWidget(healthId, {
    progress: 0.75
});
```

## Integration with Vehicle System

The widget system is automatically integrated with the vehicle gameplay:

- **Speed Display**: Shows current vehicle speed in km/h
- **Health Bar**: Displays vehicle "health" based on ground contact
- **Score Counter**: Tracks driving score with bonuses
- **Boost Button**: Interactive button for vehicle boost

Widgets update in real-time during gameplay via the `updateVehicleGameplay()` function.

## CSS Styling

Widgets are styled with CSS and can be customized by modifying the `#widget-overlay` styles in `index.css`. The overlay container has `z-index: 1000` to appear above the Three.js canvas.
const imageId = WidgetAPI.createWidget('image', {
    imageUrl: 'path/to/image.png',
    width: 1,
    height: 1,
    position: new THREE.Vector3(0, 1, -3)
});

// Create a button
const buttonId = WidgetAPI.createWidget('button', {
    text: 'Click Me!',
    width: 1.5,
    height: 0.5,
    onClick: (id) => console.log('Button clicked:', id),
    position: new THREE.Vector3(0, 0.5, -3)
});
```

### Updating Widgets
```javascript
// Update text content
WidgetAPI.updateWidget(textId, { text: 'New Text!' });

// Update progress
WidgetAPI.updateWidget(progressId, { progress: 0.9 });

// Change colors
WidgetAPI.updateWidget(textId, { color: '#ff0000' });

// Update image
WidgetAPI.updateWidget(imageId, { imageUrl: 'new-image.png' });
```

### Positioning and Visibility
```javascript
// Set world position
WidgetAPI.setWidgetPosition(widgetId, new THREE.Vector3(5, 3, 0));

// Set screen position (normalized coordinates)
WidgetAPI.setWidgetPosition(widgetId, new THREE.Vector3(0.1, 0.9, 0.5), 'screen');

// Rotate widget
WidgetAPI.setWidgetRotation(widgetId, new THREE.Euler(0, Math.PI/4, 0));

// Scale widget
WidgetAPI.setWidgetScale(widgetId, 2.0);

// Show/hide widget
WidgetAPI.showWidget(widgetId, false);
```

### Managing Widgets
```javascript
// Remove widget
WidgetAPI.removeWidget(widgetId);

// Get widget object
const widget = WidgetAPI.getWidget(widgetId);

// Get all widgets
const allWidgets = WidgetAPI.getAllWidgets();
```

## Example Usage in Game Code

```javascript
// Create HUD elements
const scoreId = WidgetAPI.createWidget('text', {
    text: 'Score: 0',
    position: new THREE.Vector3(-2, 2, -2),
    fontSize: 20,
    color: '#ffff00'
});

const healthId = WidgetAPI.createWidget('progress', {
    progress: 1.0,
    width: 2,
    height: 0.2,
    fillColor: '#00ff00',
    position: new THREE.Vector3(0, 1.8, -2)
});

// Update during gameplay
function updateHUD() {
    WidgetAPI.updateWidget(scoreId, { text: `Score: ${playerScore}` });
    WidgetAPI.updateWidget(healthId, { progress: playerHealth / 100 });
}
```

## Live Examples

The application includes live examples that demonstrate:
- **Score Display**: Updates with driving time and bonuses
- **Speedometer**: Shows current vehicle speed in km/h
- **Health Bar**: Visualizes vehicle "health" based on ground contact

Open the browser console to see the widget IDs and try the API functions!

## Technical Details

- Widgets are rendered as Three.js meshes in the scene
- Text widgets use HTML5 Canvas for rendering
- Images are loaded asynchronously via Three.js TextureLoader
- All widgets support position, rotation, and scale transformations
- Screen space positioning converts normalized coordinates to world space
- Widgets are updated every frame in the main render loop