"""Build the IP deployment kit and standalone browser extension from one committed tree."""
import argparse
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
from zipfile import ZipFile, ZIP_DEFLATED


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--revision",default="HEAD")
    cli.add_argument("--output",type=Path,required=True)
    args=cli.parse_args()
    root=Path(__file__).resolve().parents[1]
    def git(*cmd):
        return subprocess.check_output(["git","-C",str(root),*cmd])
    sha=git("rev-parse","--verify",args.revision+"^{commit}").decode().strip()
    files=("deploy/bootstrap","deploy/node_agent.py","deploy/Install-VestNode.ps1","deploy/dispatch_update.py","extension")
    with tarfile.open(fileobj=io.BytesIO(git("archive",sha,*files))) as tree:
        data={entry.name:tree.extractfile(entry).read() for entry in tree if entry.isfile()}
    manifest=json.loads(data["extension/manifest.json"])
    version=manifest["version"]
    required=[manifest["background"]["service_worker"],manifest["action"]["default_popup"]]
    required.extend(name for group in manifest["content_scripts"] for name in group["js"])
    for name in required:
        if "extension/"+name not in data:
            raise ValueError("Missing extension file: "+name)
    data["deploy/bootstrap/release.json"]=(json.dumps({"revision":sha,"version":version})+"\n").encode()
    args.output.mkdir(exist_ok=True,parents=True)
    kit=args.output/f"vest-deploy-{version}.tar.gz"
    extension=args.output/f"vest-extension-{version}.zip"
    with tarfile.open(kit,"w:gz") as tar, ZipFile(extension,"w",ZIP_DEFLATED) as browser:
        for path,body in sorted(data.items()):
            if path.startswith("extension/"):
                browser.writestr(path[len("extension/"):],body)
            else:
                info=tarfile.TarInfo("vest-deploy/"+path)
                info.size=len(body)
                info.mode=0o755 if path.endswith(".sh") else 0o644
                tar.addfile(info,io.BytesIO(body))
    shutil.copyfile(kit,args.output/"vest-deploy.tar.gz")
    print(version,sha,kit,extension,sep="\n")


if __name__=="__main__":
    main()
