from flask import Flask, render_template, request
import base64
import re
import os

app = Flask(__name__)
MODEL_DIR = os.path.join(app.root_path, 'static', 'models')

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/save_paint', methods=['POST'])
def save_paint():
    data_url = request.form["image"]
    img_str = re.sub("^data:image/png;base64,", "", data_url)
    img_bytes = base64.b64decode(img_str)
    
    with open("static/models/Lamborginhi Aventador_diffuse.jpg", "wb") as f:
        f.write(img_bytes)
    return "OK", 200

if __name__ == '__main__':
    app.run(debug=True)
