$port = 8080
$path = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  WALKMAN 3D - SERVIDOR WEB LOCAL         " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Servidor activo en: http://127.0.0.1:$port/" -ForegroundColor Yellow
Write-Host "Abre esa URL en tu navegador preferido." -ForegroundColor White
Write-Host "Presiona Ctrl+C para detener." -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Cyan

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json"
    ".fbx"  = "application/octet-stream"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.LocalPath.Replace('/', '\')
        if ($urlPath -eq "\log") {
            $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
            $body = $reader.ReadToEnd()
            [System.IO.File]::WriteAllText((Join-Path $path "mesh_debug.json"), $body, [System.Text.Encoding]::UTF8)
            Write-Host "Received debug info!" -ForegroundColor Green
            $response.StatusCode = 200
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $buffer = [System.Text.Encoding]::UTF8.GetBytes("OK")
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            continue
        }
        if ($urlPath -eq "\") { $urlPath = "\index.html" }
        
        $localFilePath = Join-Path $path $urlPath

        if (Test-Path $localFilePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($localFilePath).ToLower()
            if ($mimeTypes.ContainsKey($ext)) {
                $response.ContentType = $mimeTypes[$ext]
            } else {
                $response.ContentType = "application/octet-stream"
            }

            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.AddHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            $response.AddHeader("Pragma", "no-cache")
            
            $fs = [System.IO.File]::OpenRead($localFilePath)
            $response.ContentLength64 = $fs.Length
            $fs.CopyTo($response.OutputStream)
            $fs.Close()
        } else {
            $response.StatusCode = 404
            $buffer = [System.Text.Encoding]::UTF8.GetBytes("404 File Not Found")
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $response.Close()
    } catch {
        # ignore client aborted errors
    }
}
